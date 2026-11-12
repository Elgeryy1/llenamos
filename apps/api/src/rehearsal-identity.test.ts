import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHmac, createPrivateKey, createPublicKey } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { configuration } from './config.js'
import { firebaseVerifier } from './auth.js'
import { SignJWT, createLocalJWKSet } from 'jose'
import { rehearsalIdentity } from './rehearsal-identity.js'

const dir = mkdtempSync(join(tmpdir(), 'llenamos-rehearsal-'))
const secretFile = join(dir, 'rehearsal_identity_secret'), urlFile = join(dir, 'database-url')
const secret = 'ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12cd34ef56'
writeFileSync(secretFile, secret); writeFileSync(urlFile, 'postgresql://app:x@db:5432/llenamos')
const base = { FIREBASE_PROJECT_ID: 'llenamos-logiqd', DATABASE_URL_FILE: urlFile, TRUSTED_IP_HEADER: 'x-real-ip', TRUSTED_PROXY_ADDRESSES: '172.30.43.3' }
const rehearsalBase = { ...base, FIREBASE_PROJECT_ID: 'llenamos-ensayo' }
const rehearsal = { REHEARSAL_IDENTITY_URL: 'http://identity:9102', REHEARSAL_IDENTITY_SECRET_FILE: secretFile }
// El único secreto admitido es /run/secrets/rehearsal_identity_secret; las pruebas inyectan otra ruta con la misma exigencia.
const allowed = { rehearsalSecretPath: secretFile }
const config = (env: NodeJS.ProcessEnv) => configuration(env, allowed)

describe('La identidad de ensayo no existe en producción', () => {
  it('la imagen de producción (NODE_ENV=production) se niega a arrancar con la variable', () => {
    expect(() => config({ ...base, NODE_ENV: 'production', ...rehearsal })).toThrow(/rechaza la identidad de ensayo/)
  })
  it('tampoco con NODE_ENV ausente, development o test', () => {
    for (const env of [undefined, 'development', 'test', 'Production'])
      expect(() => config({ ...base, ...(env ? { NODE_ENV: env } : {}), ...rehearsal })).toThrow(/NODE_ENV=rehearsal/)
  })
  it('rechaza también el secreto suelto, sin la URL', () => {
    expect(() => config({ ...base, NODE_ENV: 'production', REHEARSAL_IDENTITY_SECRET_FILE: secretFile })).toThrow(/NODE_ENV=rehearsal/)
  })
  it('NODE_ENV=rehearsal sin configuración de ensayo no arranca como producción (API y worker deciden igual)', () => {
    expect(() => config({ ...base, NODE_ENV: 'rehearsal' })).toThrow(/NODE_ENV=rehearsal exige REHEARSAL_IDENTITY_URL/)
    expect(() => config({ ...rehearsalBase, NODE_ENV: 'rehearsal' })).toThrow(/NODE_ENV=rehearsal exige/)
  })
  it('en producción sin la variable la configuración sigue siendo la real', () => {
    expect(config({ ...base, NODE_ENV: 'production' }).rehearsal).toBeUndefined()
  })
  it('en modo ensayo rechaza el ID de producción y exige terminar en -ensayo', () => {
    expect(() => config({ ...base, NODE_ENV: 'rehearsal', ...rehearsal })).toThrow(/FIREBASE_PROJECT_ID debe ser un identificador de ensayo/)
    expect(() => config({ ...base, FIREBASE_PROJECT_ID: 'otro-proyecto', NODE_ENV: 'rehearsal', ...rehearsal })).toThrow(/FIREBASE_PROJECT_ID debe ser un identificador de ensayo/)
  })
  it('en modo ensayo rechaza URLs externas o de metadatos', () => {
    for (const badUrl of ['https://atacante.example', 'http://169.254.169.254', 'http://web:3000', 'http://identity:9102/extra'])
      expect(() => config({ ...rehearsalBase, NODE_ENV: 'rehearsal', ...rehearsal, REHEARSAL_IDENTITY_URL: badUrl })).toThrow(/REHEARSAL_IDENTITY_URL solo admite/)
  })
  it('en modo ensayo solo vale el secreto exclusivo: ni otro fichero, ni un nombre parecido, ni un enlace simbólico', () => {
    const dbFile = join(dir, 'api_database_url'); writeFileSync(dbFile, secret)
    const lookalike = join(dir, 'x_rehearsal_identity_secret'); writeFileSync(lookalike, secret)
    const viaLink = join(dir, 'enlace', 'rehearsal_identity_secret'); mkdirSync(join(dir, 'enlace')); symlinkSync(dbFile, viaLink)
    for (const bad of [dbFile, lookalike, viaLink, join(dir, 'no-existe')])
      expect(() => config({ ...rehearsalBase, NODE_ENV: 'rehearsal', ...rehearsal, REHEARSAL_IDENTITY_SECRET_FILE: bad }), bad).toThrow(/REHEARSAL_IDENTITY_SECRET_FILE/)
    // Un enlace que resuelve exactamente al secreto exclusivo sí vale: se compara la ruta real.
    const good = join(dir, 'enlace', 'bueno'); symlinkSync(secretFile, good)
    expect(config({ ...rehearsalBase, NODE_ENV: 'rehearsal', ...rehearsal, REHEARSAL_IDENTITY_SECRET_FILE: good }).rehearsal?.secret).toBe(secret)
  })
  it('exige que el contenido sea hexadecimal de 24 bytes', () => {
    const weak = join(dir, 'debil'); writeFileSync(weak, 'secreto-de-ensayo-123456')
    expect(() => configuration({ ...rehearsalBase, NODE_ENV: 'rehearsal', ...rehearsal, REHEARSAL_IDENTITY_SECRET_FILE: weak }, { rehearsalSecretPath: weak })).toThrow(/hexadecimal de 24 bytes/)
  })
  it('con NODE_ENV=rehearsal y parámetros correctos se activa con éxito', () => {
    expect(config({ ...rehearsalBase, NODE_ENV: 'rehearsal', ...rehearsal }).rehearsal).toEqual({ url: 'http://identity:9102', secret })
    expect(() => config({ FIREBASE_PROJECT_ID: rehearsalBase.FIREBASE_PROJECT_ID, DATABASE_URL_FILE: urlFile, NODE_ENV: 'rehearsal', ...rehearsal })).toThrow(/TRUSTED_IP_HEADER/)
    expect(() => config({ ...rehearsalBase, NODE_ENV: 'rehearsal', ...rehearsal, IDENTITY_ADMIN_CREDENTIAL_FILE: '/x.json' })).toThrow(/No se mezclan/)
  })
})

describe('El servicio de identidad exige el mismo secreto que la API', () => {
  it('se niega a arrancar con un secreto que no sea hexadecimal de 24 bytes', () => {
    const weak = join(dir, 'secreto-debil'); writeFileSync(weak, 'secreto-de-ensayo-123456')
    const result = spawnSync(process.execPath, [join(__dirname, '../../../deploy/vps/ensayo/identity/server.mjs')], { encoding: 'utf8', timeout: 10_000,
      env: { PATH: process.env.PATH, PORT: '0', REHEARSAL_ADMIN_SECRET_FILE: weak, REHEARSAL_STATE_FILE: join(dir, 'debil.json') } })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/hexadecimal de 24 bytes/)
  })
})

describe('El servicio de identidad no firma para proyectos que no son de ensayo', () => {
  it('se niega a arrancar con el ID de producción o sin sufijo -ensayo', () => {
    for (const project of ['llenamos-logiqd', 'otro-proyecto']) {
      const result = spawnSync(process.execPath, [join(__dirname, '../../../deploy/vps/ensayo/identity/server.mjs')], { encoding: 'utf8', timeout: 10_000,
        env: { PATH: process.env.PATH, PORT: '0', REHEARSAL_PROJECT_ID: project, REHEARSAL_ADMIN_SECRET_FILE: secretFile, REHEARSAL_STATE_FILE: join(dir, `${project}.json`) } })
      expect(result.status, project).not.toBe(0)
      expect(result.stderr).toMatch(/REHEARSAL_PROJECT_ID debe terminar en -ensayo/)
    }
  })
})

describe('Servicio de identidad de ensayo con el verificador real de la API', () => {
  let child: ChildProcess, url: string
  beforeAll(async () => {
    const port = 20000 + Math.floor(Math.random() * 20000)
    url = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, [join(__dirname, '../../../deploy/vps/ensayo/identity/server.mjs')], {
      env: { PATH: process.env.PATH, PORT: String(port), REHEARSAL_ADMIN_SECRET_FILE: secretFile, REHEARSAL_STATE_FILE: join(dir, 'state.json') }, stdio: 'ignore' })
    for (let i = 0; i < 50; i++) { try { if ((await fetch(`${url}/healthz`)).ok) return } catch { /* aún arrancando */ } await new Promise(r => setTimeout(r, 100)) }
    throw new Error('identidad de ensayo no arrancó')
  })
  afterAll(() => { child?.kill(); rmSync(dir, { recursive: true, force: true }) })
  const json = (path: string, body: unknown, auth = true) => fetch(`${url}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${secret}` } : {}) }, body: JSON.stringify(body) })

  it('alta, aceptación con contraseña, login y token aceptado por el verificador de la API', async () => {
    const { verify, admin } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    const account = await admin.resolveAccount('Camarero@Ensayo.test', 'Camarero')
    expect(account.email).toBe('camarero@ensayo.test')
    expect((await admin.resolveAccount('camarero@ensayo.test', 'Otro')).uid).toBe(account.uid)
    const version = 'b'.repeat(32)
    const validAfter = await admin.proveMailbox(account.uid, account.email, 'contraseña-larga-123', version)
    expect(validAfter).toBeLessThanOrEqual(Date.now())
    expect((await admin.account(account.uid)).claims.sessionVersion).toBe(version)
    expect((await json('/login', { email: account.email, password: 'incorrecta' }, false)).status).toBe(401)
    const login = await (await json('/login', { email: account.email, password: 'contraseña-larga-123' }, false)).json() as { idToken: string }
    expect(await verify(login.idToken)).toMatchObject({ uid: account.uid, sessionVersion: version, platformClaim: false })
  })
  it('rechaza tokens manipulados, de otro proyecto y administración sin secreto', async () => {
    const { verify } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    const op = await (await json('/admin/operator', { uid: 'operador', email: 'op@ensayo.test', password: 'contraseña-larga-123', sessionVersion: 'c'.repeat(32) })).json() as { uid: string }
    const login = await (await json('/login', { email: 'op@ensayo.test', password: 'contraseña-larga-123' }, false)).json() as { idToken: string }
    expect(await verify(login.idToken)).toMatchObject({ uid: op.uid, platformClaim: true })
    const [h, p, s] = login.idToken.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p!, 'base64url').toString()), sub: 'otro' })).toString('base64url')
    await expect(verify(`${h}.${forged}.${s}`)).rejects.toMatchObject({ status: 401 })
    await expect(rehearsalIdentity('otro-ensayo', { url, secret }).verify(login.idToken)).rejects.toMatchObject({ status: 401 })
    expect((await json('/admin/resolve', { email: 'x@y.test', displayName: 'X' }, false)).status).toBe(401)
  })
  const claimsOf = (idToken: string) => JSON.parse(Buffer.from(idToken.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>
  /** La clave privada del servicio de ensayo (estado local de la prueba) permite firmar tokens «legítimos» pero defectuosos. */
  const signer = () => createPrivateKey(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).privatePem)
  const mint = async (claims: Record<string, unknown>, issuedAt = Math.floor(Date.now() / 1000), expires: number | null = issuedAt + 3600) => {
    const jwt = new SignJWT(claims).setProtectedHeader({ alg: 'RS256', typ: 'JWT' }).setIssuedAt(issuedAt)
    if (expires !== null) jwt.setExpirationTime(expires)
    return jwt.sign(signer())
  }
  const valid = (extra: Record<string, unknown> = {}) => ({ iss: 'https://identity.ensayo.invalid/llenamos-ensayo', aud: 'llenamos-ensayo', sub: 'u1', auth_time: Math.floor(Date.now() / 1000), sessionVersion: 'a'.repeat(32), ...extra })
  it('rechaza ataques criptográficos: alg none, HS256 con la clave pública (JWK y PEM)', async () => {
    const { verify } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    const login = await (await json('/login', { email: 'camarero@ensayo.test', password: 'contraseña-larga-123' }, false)).json() as { idToken: string }
    const p = login.idToken.split('.')[1]!
    const noneHeader = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')
    await expect(verify(`${noneHeader}.${p}.`)).rejects.toMatchObject({ status: 401 })
    const jwks = await (await fetch(`${url}/jwks.json`)).json() as { keys: Array<Record<string, string>> }
    const pem = createPublicKey({ key: jwks.keys[0] as never, format: 'jwk' }).export({ type: 'spki', format: 'pem' }).toString()
    const hsHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    // Confusión de algoritmo con ambas representaciones de la clave pública: el PEM es la que usaría un atacante real.
    for (const keyMaterial of [pem, JSON.stringify(jwks.keys[0])]) {
      const forged = createHmac('sha256', keyMaterial).update(`${hsHeader}.${p}`).digest('base64url')
      await expect(verify(`${hsHeader}.${p}.${forged}`), keyMaterial.slice(0, 12)).rejects.toMatchObject({ status: 401 })
    }
  })
  it('el token válido firmado con la clave del servicio se acepta; caducado, de otro emisor, sin auth_time o de otra audiencia no', async () => {
    const { verify } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    expect(await verify(await mint(valid()))).toMatchObject({ uid: 'u1', platformClaim: false })
    const now = Math.floor(Date.now() / 1000)
    // Firma correcta de la clave del ensayo: si falla es por la regla concreta, no por la firma.
    await expect(verify(await mint(valid(), now - 7200, now - 3600))).rejects.toMatchObject({ status: 401 })
    await expect(verify(await mint(valid({ iss: 'https://securetoken.google.com/llenamos-ensayo' })))).rejects.toMatchObject({ status: 401 })
    await expect(verify(await mint(valid({ iss: 'https://identity.ensayo.invalid/otro-ensayo' })))).rejects.toMatchObject({ status: 401 })
    await expect(verify(await mint(valid({ aud: 'otro-ensayo' })))).rejects.toMatchObject({ status: 401 })
    await expect(verify(await mint({ ...valid(), auth_time: undefined }))).rejects.toMatchObject({ status: 401 })
    await expect(verify(await mint(valid(), now, null))).rejects.toMatchObject({ status: 401 })
  })
  it('verificadores cruzados sin red: producción rechaza el token de ensayo y el de ensayo rechaza el de producción', async () => {
    const jwks = await (await fetch(`${url}/jwks.json`)).json() as { keys: never[] }
    const sameKeys = createLocalJWKSet(jwks)
    // Producción con las MISMAS claves del ensayo: aun con firma válida el emisor no coincide.
    const production = firebaseVerifier('llenamos-logiqd', sameKeys)
    const login = await (await json('/login', { email: 'camarero@ensayo.test', password: 'contraseña-larga-123' }, false)).json() as { idToken: string }
    expect(claimsOf(login.idToken).iss).toBe('https://identity.ensayo.invalid/llenamos-ensayo')
    await expect(production(login.idToken)).rejects.toMatchObject({ status: 401 })
    await expect(firebaseVerifier('llenamos-ensayo', sameKeys)(login.idToken)).rejects.toMatchObject({ status: 401 })
    // Inverso: token con forma de producción (emisor securetoken, mismo uid) firmado con la clave del ensayo.
    const productionShaped = await mint({ ...valid(), iss: 'https://securetoken.google.com/llenamos-logiqd', aud: 'llenamos-logiqd' })
    expect(await production(productionShaped)).toMatchObject({ uid: 'u1' }) // el control: con esas claves producción SÍ lo aceptaría
    const { verify } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    await expect(verify(productionShaped)).rejects.toMatchObject({ status: 401 })
  })
  it('el servicio frena la fuerza bruta de /login y no revela qué correos existen', async () => {
    const noUser = await json('/login', { email: 'nadie@ensayo.test', password: 'x' }, false)
    const badPassword = await json('/login', { email: 'camarero@ensayo.test', password: 'x' }, false)
    expect([noUser.status, await noUser.json()]).toEqual([badPassword.status, await badPassword.json()])
    const codes: number[] = []
    for (let i = 0; i < 14; i++) codes.push((await json('/login', { email: 'freno@ensayo.test', password: String(i) }, false)).status)
    expect(codes.slice(0, 10).every(code => code === 401)).toBe(true)
    expect(codes.slice(10).every(code => code === 429)).toBe(true)
  })
  it('las peticiones de administración con correo no textual dan 400, no un fallo del servicio', async () => {
    expect((await json('/admin/resolve', { email: 42, displayName: 'X' })).status).toBe(400)
    expect((await json('/admin/operator', { uid: 'x', email: { a: 1 }, password: 'contraseña-larga-123', sessionVersion: 'd'.repeat(32) })).status).toBe(400)
    expect((await fetch(`${url}/healthz`)).ok).toBe(true)
  })
  it('/admin/operator no pisa una cuenta ajena', async () => {
    const { admin } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    const victim = await admin.resolveAccount('victima@ensayo.test', 'Víctima')
    expect((await json('/admin/operator', { uid: victim.uid, email: 'atacante@ensayo.test', password: 'contraseña-larga-123', sessionVersion: 'd'.repeat(32) })).status).toBe(409)
    expect((await admin.account(victim.uid)).email).toBe('victima@ensayo.test')
  })
  it('no invita cuentas de plataforma', async () => {
    const { admin } = rehearsalIdentity('llenamos-ensayo', { url, secret })
    await expect(admin.resolveAccount('op@ensayo.test', 'Operador')).rejects.toMatchObject({ status: 412 })
  })
})
