import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Pool } from 'pg'
import { decryptToken } from './invitations/crypto.js'
import { createInvitationService } from './invitations/service.js'
import { rehearsalIdentity } from './rehearsal-identity.js'
import { apiServer } from './server.js'
import { integrationVault } from './platform/integrations.js'
import { createTestDatabase } from './test-support.js'

const enabled = process.env.TEST_POSTGRES_API === '1' && !!process.env.TEST_POSTGRES_URL
describe.skipIf(!enabled)('Identidad de ensayo con PostgreSQL real: alta, invitación, aceptación y sesión', { timeout: 60_000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'llenamos-rehearsal-int-')), secret = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56', key = randomBytes(32)
  writeFileSync(join(dir, 'secret'), secret)
  let db: Awaited<ReturnType<typeof createTestDatabase>>, app: Pool, child: ChildProcess, server: ReturnType<typeof apiServer>, base = '', idp = ''
  const post = (path: string, body: unknown, token?: string) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) })
  const login = async (email: string, password: string) => (await (await fetch(`${idp}/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) })).json() as { idToken: string }).idToken

  beforeAll(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    idp = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [join(__dirname, '../../../deploy/vps/ensayo/identity/server.mjs')], { env: { PATH: process.env.PATH, PORT: String(port), REHEARSAL_ADMIN_SECRET_FILE: join(dir, 'secret'), REHEARSAL_STATE_FILE: join(dir, 'state.json') }, stdio: 'ignore' })
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${idp}/healthz`)).ok) break } catch { /* arrancando */ } await new Promise(r => setTimeout(r, 100)) }
    db = await createTestDatabase('rehearsal')
    app = new Pool({ connectionString: db.appUrl, max: 6 })
    // Operador de plataforma: fila SQL + cuenta con claim `logiqd` en la identidad de ensayo.
    await db.admin.query("INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES('operador',$1,to_timestamp(0),false,true)", ['c'.repeat(32)])
    await fetch(`${idp}/admin/operator`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` }, body: JSON.stringify({ uid: 'operador', email: 'op@ensayo.test', password: 'contraseña-larga-123', sessionVersion: 'c'.repeat(32) }) })
    const { verify, admin } = rehearsalIdentity('llenamos-ensayo', { url: idp, secret })
    server = apiServer(app, verify, () => undefined, { invitations: createInvitationService(app, admin, { encryptionKey: key }), integrationVault: integrationVault(randomBytes(32)) })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterAll(async () => {
    child?.kill(); server?.closeAllConnections(); await new Promise(resolve => server?.close(resolve))
    await app?.end(); await db?.drop(); rmSync(dir, { recursive: true, force: true })
  })

  it('operador de LogiQD da de alta; la propietaria acepta con su contraseña y entra; el token viejo y el ajeno no valen', async () => {
    const operator = await login('op@ensayo.test', 'contraseña-larga-123')
    const plans = (await (await post('/v1/operations/listarPlanesDisponibles', { data: {} })).json() as { result: { plans: Array<{ id: string; version: number }> } }).result.plans
    const created = await post('/v1/operations/altaRestauranteLogiqd', { data: { requestId: `alta_${randomUUID().replaceAll('-', '')}`, ownerEmail: 'jefa@ensayo.test', ownerName: 'Jefa', name: 'Casa Ensayo', slug: 'casa-ensayo-int', locationName: 'Local', planId: plans[0]!.id, planVersion: plans[0]!.version } }, operator)
    expect(created.status, await created.clone().text()).toBe(200)
    const { restaurantId } = (await created.json() as { result: { restaurantId: string } }).result
    // Sin correo, la invitación queda pendiente; se descifra el token como lo haría el proveedor de correo.
    const invitation = (await db.admin.query<{ id: string; token_ciphertext: { iv: string; tag: string; data: string } }>('SELECT id,token_ciphertext FROM llenamos.account_invitations WHERE restaurant_id=$1', [restaurantId])).rows[0]!
    const accepted = await post('/v1/operations/aceptarInvitacion', { data: { invitationId: invitation.id, token: decryptToken(key, invitation.id, invitation.token_ciphertext), password: 'contraseña-de-la-jefa-1' } })
    expect(accepted.status, await accepted.clone().text()).toBe(200)
    const owner = await login('jefa@ensayo.test', 'contraseña-de-la-jefa-1')
    const session = await (await fetch(`${base}/v1/session`, { headers: { Authorization: `Bearer ${owner}` } })).json() as { memberships: Array<{ restaurantId: string; role: string }> }
    expect(session.memberships).toEqual([expect.objectContaining({ restaurantId, role: 'owner' })])
    expect((await fetch(`${base}/v1/restaurants/${restaurantId}/context`, { headers: { Authorization: `Bearer ${operator}` } })).status).toBe(403) // LogiQD no ve el interior
    expect((await fetch(`${base}/v1/session`, { headers: { Authorization: `Bearer ${owner.slice(0, -4)}AAAA` } })).status).toBe(401) // token manipulado
    expect((await post('/v1/operations/aceptarInvitacion', { data: { invitationId: invitation.id, token: 'A'.repeat(43), password: 'otra-contraseña-larga-1' } })).status).toBe(412)
    expect((await post('/v1/operations/altaRestauranteLogiqd', { data: {} }, owner)).status).toBe(400)
  })
})
