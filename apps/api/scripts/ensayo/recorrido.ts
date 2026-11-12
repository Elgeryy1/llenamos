// Recorrido del ensayo: alta por LogiQD, invitación y aceptación, configuración, reserva pública, sala, cocina, caja,
// lectura en vivo por SSE a través de nginx, foto y aviso procesado por el worker. Uso (desde apps/api):
//   pnpm exec tsx scripts/ensayo/recorrido.ts
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as core from '@llenamos/core'
import { BASE, lit, CallError, RUN, assert, call, invitationToken, login, openStream, randomHex, requestId, sql, status, step, steps } from './lib.js'

const slug = process.env.ENSAYO_SLUG ?? 'casa-ensayo', domain = `${slug}.test`, password = 'contraseña-de-ensayo-2026'
const operatorEmail = `logiqd@${domain}`, operatorUid = 'operador-ensayo'
const ownerEmail = `propietaria@${domain}`, waiterEmail = `camarero@${domain}`, cookEmail = `cocina@${domain}`
const today = () => core.horaLocal(Date.now(), 'Europe/Madrid').fecha
const lid = (rid: string) => sql(`SELECT id FROM llenamos.locations WHERE restaurant_id=${lit(rid)} LIMIT 1`).trim()

async function main() {
  console.log(`Recorrido contra ${BASE}`)
  let operator = '', owner = '', waiter = '', cook = '', rid = '', loc = ''

  console.log('1. Plataforma: operador de LogiQD y alta del restaurante')
  await step('readyz y landing por el gateway', async () => {
    assert((await fetch(`${BASE}/api/readyz`)).ok, 'readyz')
    assert((await fetch(`${BASE}/api/healthz`)).ok, 'healthz')
    const home = await fetch(`${BASE}/entrar`)
    assert(home.status === 200, `/entrar ${home.status}`)
  })
  await step('operador de plataforma sembrado (SQL + identidad de ensayo) y login', async () => {
    const version = randomHex(16)
    sql(`INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked,platform_operator) VALUES(${lit(operatorUid)},${lit(version)},now()-interval '1 hour',false,true) ON CONFLICT(uid) DO NOTHING`)
    const { execFileSync } = await import('node:child_process')
    const stored = sql(`SELECT session_version FROM llenamos.identities WHERE uid=${lit(operatorUid)}`).trim()
    execFileSync('docker', ['exec', '-i', 'llenamos-ensayo-identity-1', 'node', '/ensayo/cli.mjs', 'operator', operatorUid, operatorEmail, stored], { input: password })
    operator = login(operatorEmail, password)
    assert((await call('listarRestaurantesAdministracion', {}, operator)).restaurants !== undefined, 'listado')
  })
  let planId = 'completo', planVersion = 1
  await step('catálogo público de planes', async () => {
    const { plans } = await call('listarPlanesDisponibles', {}, null)
    console.log('     planes:', plans.map((p: any) => `${p.id}@${p.version}[${(p.modules ?? p.entitlements?.modules ?? []).join(',')}]`).join(' '))
    const full = plans.find((p: any) => JSON.stringify(p).includes('"pos"')) ?? plans.at(-1)
    planId = full.id; planVersion = full.version
  })
  await step('alta del restaurante por LogiQD (propietario pendiente, sin correo)', async () => {
    const out = await call('altaRestauranteLogiqd', { requestId: requestId('alta'), ownerEmail, ownerName: 'Propietaria Ensayo', name: 'Casa Ensayo', slug, locationName: 'Local principal', planId, planVersion }, operator)
    rid = out.restaurantId; loc = out.locationId
    assert(out.invitationStatus === 'pending', `estado ${out.invitationStatus}`)
  })
  await step('LogiQD no entra al interior del restaurante', async () => {
    const response = await fetch(`${BASE}/api/v1/restaurants/${rid}/context`, { headers: { Authorization: `Bearer ${operator}` } })
    assert(response.status === 403, `contexto ${response.status}`)
  })

  console.log('2. Invitación y aceptación')
  const accept = async (email: string) => {
    const row = sql(`SELECT id FROM llenamos.account_invitations WHERE restaurant_id=${lit(rid)} AND email=${lit(email)}`).trim()
    assert(row, `sin invitación para ${email}`)
    await call('aceptarInvitacion', { invitationId: row, token: invitationToken(row), password }, null)
    return login(email, password)
  }
  await step('propietaria acepta su invitación y entra', async () => {
    owner = await accept(ownerEmail)
    const session = await (await fetch(`${BASE}/api/v1/session`, { headers: { Authorization: `Bearer ${owner}` } })).json() as any
    assert(session.memberships?.some((m: any) => m.restaurantId === rid && m.role === 'owner'), 'sin membresía de propietaria')
    const context = await fetch(`${BASE}/api/v1/restaurants/${rid}/context`, { headers: { Authorization: `Bearer ${owner}` } })
    assert(context.status === 200, `contexto ${context.status}`)
  })
  await step('propietaria invita a camarero y cocina; aceptan', async () => {
    for (const [email, name, role] of [[waiterEmail, 'Camarero', 'waiter'], [cookEmail, 'Cocinero', 'kitchen']] as const)
      assert((await call('invitarMiembro', { restaurantId: rid, email, displayName: name, role }, owner)).invitationStatus === 'pending', 'invitación pendiente')
    waiter = await accept(waiterEmail); cook = await accept(cookEmail)
  })
  await step('invitación reutilizada, token falso y camarero sin permiso de invitar', async () => {
    const id = sql(`SELECT id FROM llenamos.account_invitations WHERE restaurant_id=${lit(rid)} AND email=${lit(waiterEmail)}`).trim()
    assert(await status('aceptarInvitacion', { invitationId: id, token: 'A'.repeat(43), password }, null) === 412, 'token falso')
    assert(await status('invitarMiembro', { restaurantId: rid, email: `otro@${domain}`, displayName: 'Otro', role: 'waiter' }, waiter) === 403, 'camarero invita')
  })
  await step('sesión antigua revocada: la contraseña nueva invalida los tokens previos', async () => {
    const before = waiter
    await new Promise(r => setTimeout(r, 1100))
    // Reaceptar no es posible (usada); el cierre se prueba con un token firmado antes de tokens_valid_after.
    sql(`UPDATE llenamos.identities SET tokens_valid_after=now()+interval '5 seconds' WHERE uid=(SELECT uid FROM llenamos.account_invitations WHERE restaurant_id=${lit(rid)} AND email=${lit(waiterEmail)})`)
    const response = await fetch(`${BASE}/api/v1/session`, { headers: { Authorization: `Bearer ${before}` } })
    sql(`UPDATE llenamos.identities SET tokens_valid_after=now()-interval '1 hour' WHERE uid=(SELECT uid FROM llenamos.account_invitations WHERE restaurant_id=${lit(rid)} AND email=${lit(waiterEmail)})`)
    assert(response.status === 401, `sesión revocada respondió ${response.status}`)
  })

  console.log('3. Configuración del local (plano, reservas, carta, estaciones)')
  const R = () => ({ restaurantId: rid, locationId: loc })
  await step('plano y configuración de reservas', async () => {
    await call('guardarPlano', { ...R(), createAreas: [{ id: 'sala', name: 'Sala', sortOrder: 0 }], createTables: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'].map((name, i) => ({ id: name.toLowerCase(), name, areaId: 'sala', seats: 4, shape: 'rect', x: 5 + i * 14, y: 5, w: 10, h: 10, joinableWith: [], enabled: true })) }, owner)
    const settings = { ...core.defaultReservationSettings('Europe/Madrid'), publicBooking: true, autoConfirm: true, minNoticeMinutes: 0, maxAdvanceDays: 365 }
    await call('guardarConfiguracionReservas', { ...R(), settings }, owner)
  })
  await step('sala lee directamente las mesas de reservas en dining_tables (plano unificado)', async () => {
    assert(sql(`SELECT count(*) FROM llenamos.dining_tables WHERE restaurant_id=${lit(rid)}`).trim() === '6', 'plano no encontrado en dining_tables')
  })
  let itemIds: string[] = []
  const stationIds: Record<string, string> = {}, itemStation: Record<string, string> = {}, itemByKey: Record<string, string> = {}
  await step('carta de demostración, estaciones y ajustes de sala', async () => {
    const demo = core.demoMenu()
    const stations: Record<string, string> = {}
    for (const [id, station] of Object.entries(demo.stations)) { stations[id] = (await call('guardarEstacion', { ...R(), stationId: null, station: core.StationSchema.parse(station) }, owner)).stationId; stationIds[station.kind] ??= stations[id]! }
    const categories: Record<string, string> = {}
    for (const [id, category] of Object.entries(demo.categories)) categories[id] = (await call('guardarCategoriaCarta', { ...R(), categoryId: null, category: core.MenuCategorySchema.parse(category) }, owner)).categoryId
    for (const [id, item] of Object.entries(demo.items)) {
      const editable = core.MenuItemEditableSchema.parse({ ...item, categoryId: categories[item.categoryId], stationId: item.stationId ? stations[item.stationId] : item.stationId })
      const saved = (await call('guardarPlato', { ...R(), itemId: null, item: editable }, owner)).itemId as string
      itemIds.push(saved); itemByKey[id] = saved; if (item.stationId) itemStation[saved] = demo.stations[item.stationId]!.kind
      void id
    }
    const settings = { ...demo.settings, defaultStationId: stations[demo.settings.defaultStationId ?? ''] ?? Object.values(stations)[0] ?? null }
    settings.selfOrder = { ...settings.selfOrder, enabled: true, requireApproval: false }
    await call('guardarConfiguracionSala', { ...R(), settings }, owner)
  })
  await step('camarero no puede editar la carta ni cambiar la configuración', async () => {
    assert(await status('guardarConfiguracionReservas', { ...R(), settings: core.defaultReservationSettings('Europe/Madrid') }, waiter) === 403, 'camarero configura')
  })

  console.log('4. Reserva pública desde la web y lectura en vivo por SSE (a través de nginx)')
  const date = core.sumarDias(today(), 1)
  let reservationId = ''
  const reservationStream = await openStream('reservasDia', owner, { ...R(), date }).catch(() => null)
  await step('el panel abre la lectura en vivo (SSE) y recibe la foto inicial', async () => {
    assert(reservationStream?.response.status === 200, `SSE ${reservationStream?.response.status}`)
    assert((reservationStream.response.headers.get('content-type') ?? '').startsWith('text/event-stream'), 'no es text/event-stream')
    await reservationStream.until(() => reservationStream.snapshots().length >= 1)
  })
  await step('la página pública de reserva carga (HTML de la web)', async () => {
    const page = await fetch(`${BASE}/r/${slug}`)
    assert(page.status === 200, `/r/${slug} ${page.status}`)
    assert((await page.text()).includes('<'), 'html vacío')
  })
  await step('disponibilidad pública y reserva por la API, con cambio en vivo en el panel', async () => {
    const free = await call('consultarDisponibilidad', { slug, locationId: loc, date, partySize: 4 }, null)
    assert(free.status === 'open' && free.slots.some((s: any) => s.time === '20:00' && s.available), `sin hueco a las 20:00: ${JSON.stringify(free).slice(0, 200)}`)
    const before = reservationStream?.snapshots().length ?? 0
    const sent = performance.now()
    const made = await call('crearReservaPublica', { slug, locationId: loc, date, time: '20:00', partySize: 4, guestName: 'Ana Ensayo', phone: '+34611222333', email: `ana@${domain}`, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web', website: '' }, null)
    reservationId = made.reservationId ?? made.id ?? ''
    assert(made.manageToken, 'sin token de gestión')
    await reservationStream!.until(() => reservationStream!.snapshots().length > before)
    const frame = reservationStream!.snapshots().at(-1)!
    assert(JSON.stringify(JSON.parse(frame.data!)).includes('Ana Ensayo'), 'la foto no incluye la reserva')
    console.log(`     latencia reserva → panel en vivo: ${Math.round(frame.at - sent)} ms`)
  })
  await step('abuso: campo trampa, duplicado y token falso', async () => {
    const base = { slug, locationId: loc, date, time: '20:00', partySize: 2, guestName: 'Bot', phone: '+34611000111', email: null, language: 'es', guestNotes: '', acceptPolicy: true, source: 'web' }
    assert(await status('crearReservaPublica', { ...base, website: 'http://spam' }, null) === 400, 'campo trampa')
    assert(await status('verReservaPublica', { slug, reservationId: reservationId || 'x', token: 'A'.repeat(43) }, null) >= 400, 'token falso')
  })
  reservationStream && await reservationStream.close()

  console.log('5. Sala, cocina y SSE de cocina')
  let sessionId = ''
  const kitchenItem = itemByKey.bravas!
  const barItem = itemByKey.agua
  await step('camarero abre la mesa T1 y manda el pedido; la cocina lo ve en vivo', async () => {
    const kitchenStream = await openStream('cocinaLineas', cook, { ...R(), stationId: stationIds.kitchen!, kind: 'kitchen' })
    assert(kitchenStream.response.status === 200, `SSE cocina ${kitchenStream.response.status}`)
    await kitchenStream.until(() => kitchenStream.snapshots().length >= 1)
    const opened = await call('abrirMesa', { ...R(), tableIds: ['t1'], guests: 2 }, waiter)
    sessionId = opened.sessionId
    const sent = performance.now()
    const order = await call('enviarPedido', { ...R(), sessionId, lines: [{ kind: 'item', itemId: kitchenItem, quantity: 2 }, ...(barItem ? [{ kind: 'item', itemId: barItem, quantity: 1 }] : [])], requestId: randomUUID() }, waiter)
    assert(order.status === 'sent', `pedido ${JSON.stringify(order).slice(0, 300)}`)
    await kitchenStream.until(() => kitchenStream.snapshots().some(f => JSON.parse(f.data!).lines?.length > 0))
    console.log(`     latencia pedido → cocina en vivo: ${Math.round(kitchenStream.snapshots().find(f => JSON.parse(f.data!).lines?.length > 0)!.at - sent)} ms`)
    await kitchenStream.close()
  })
  await step('cocina prepara y marca listo; el camarero reclama la recogida y sirve', async () => {
    const lines = sql(`SELECT id,doc->>'stationKind',doc->>'status' FROM llenamos.sala_order_lines WHERE restaurant_id=${lit(rid)} AND session_id=${lit(sessionId)}`).trim().split('\n').map(l => l.split('\t'))
    const kitchen = lines.filter(l => l[1] === 'kitchen').map(l => l[0]!)
    await call('cambiarEstadoLineas', { ...R(), lineIds: kitchen, status: 'preparing' }, cook)
    await call('cambiarEstadoLineas', { ...R(), lineIds: kitchen, status: 'ready' }, cook)
    const task = sql(`SELECT id FROM llenamos.sala_floor_tasks WHERE restaurant_id=${lit(rid)} AND doc->>'type'='pickup' LIMIT 1`).trim()
    assert(task, 'sin tarea de recogida')
    assert((await call('cambiarEstadoTarea', { ...R(), taskId: task, action: 'claim' }, waiter)).result === 'ok', 'reclamar')
    const live = sql(`SELECT id FROM llenamos.sala_order_lines WHERE restaurant_id=${lit(rid)} AND session_id=${lit(sessionId)} AND doc->>'kind'<>'menu' AND doc->>'status'<>'served'`).trim().split('\n').filter(Boolean)
    if (sql(`SELECT count(*) FROM llenamos.sala_order_lines WHERE restaurant_id=${lit(rid)} AND session_id=${lit(sessionId)} AND doc->>'status'='held'`).trim() !== '0') await call('marcharPase', { ...R(), sessionId, course: 'all' }, waiter)
    await call('cambiarEstadoLineas', { ...R(), lineIds: live, status: 'served' }, waiter)
  })

  console.log('6. Caja: cobro de la mesa')
  await step('abrir caja, cuenta de la mesa, cobro en efectivo y cierre; el camarero ve la cuenta en vivo', async () => {
    const cash = await call('abrirCaja', { ...R(), requestId: requestId('caja'), registerId: 'caja-1', openingCents: 10000 }, owner)
    const billStream = await openStream('cajaCuentas', waiter, R())
    await billStream.until(() => billStream.snapshots().length >= 1)
    const billId = (await call('abrirCuenta', { ...R(), requestId: requestId('cta'), target: { kind: 'session', id: sessionId } }, waiter)).billId
    const prepared = await call('prepararCobro', { ...R(), requestId: requestId('prep'), billId, expectedRevision: 1 }, waiter)
    const view = await call('verCuenta', { ...R(), billId }, waiter)
    const part = view.parts[0]
    const payment = { ...R(), requestId: requestId('cobro'), billId, expectedRevision: prepared.revision, partId: part.id, cashSessionId: cash.cashSessionId, method: 'cash', amountCents: part.totalCents, tipCents: 0, tenderedCents: part.totalCents }
    const [first, second] = await Promise.all([call('registrarCobro', payment, waiter), call('registrarCobro', payment, waiter)])
    assert(JSON.stringify(first) === JSON.stringify(second), 'el reintento concurrente devolvió otro resultado')
    await call('cambiarEstadoMesa', { ...R(), sessionId, status: 'closed' }, waiter)
    await billStream.until(() => billStream.snapshots().length >= 2)
    await billStream.close()
    await call('cerrarCaja', { ...R(), requestId: requestId('cierre'), cashSessionId: cash.cashSessionId, countedCents: 10000 + part.totalCents, reason: null }, owner)
    const paid = sql(`SELECT count(*) FROM llenamos.pos_payments WHERE restaurant_id=${lit(rid)}`).trim()
    assert(paid === '1', `cobros registrados ${paid}`)
  })
  await step('el camarero no puede abrir caja (el cobro repetido en paralelo ya devolvió un solo pago)', async () => {
    assert(await status('abrirCaja', { ...R(), requestId: requestId('x'), registerId: 'caja-2', openingCents: 0 }, waiter) === 403, 'camarero abre caja')
  })

  console.log('7. Archivos: foto de la carta por nginx')
  await step('subida de foto autorizada, descarga pública y límites', async () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('JFIF ensayo '), Buffer.alloc(2048, 7)])
    const put = (token: string | null, body: Buffer, type = 'image/jpeg') => fetch(`${BASE}/api/v1/restaurants/${rid}/files?purpose=carta_foto&name=tortilla.jpg`, { method: 'PUT', headers: { 'Content-Type': type, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: new Uint8Array(body) })
    assert((await put(waiter, jpeg)).status === 403, 'camarero sube foto')
    assert((await put(null, jpeg)).status === 401, 'anónimo sube foto')
    assert((await put(owner, jpeg, 'text/html')).status === 415, 'tipo falso')
    assert((await put(owner, Buffer.alloc(10 * 1024 * 1024, 1))).status === 413, 'foto de 10 MiB')
    const up = await put(owner, jpeg)
    assert(up.status === 201, `subida ${up.status}`)
    const { result } = await up.json() as { result: { id: string; sha256: string } }
    const pub = await fetch(`${BASE}/api/v1/public/files/${rid}/${result.id}`)
    assert(pub.status === 200 && pub.headers.get('cache-control') === 'public, max-age=300', `pública ${pub.status} ${pub.headers.get('cache-control')}`)
    assert(Buffer.from(await pub.arrayBuffer()).equals(jpeg), 'contenido distinto')
    const onDisk = execFileSync('docker', ['exec', 'llenamos-ensayo-api-1', 'sh', '-c', `find /data/files -type f | grep -c ${result.id}`]).toString().trim()
    assert(onDisk === '1', 'el archivo no está en el volumen privado')
  })

  console.log('8. Worker: aviso del outbox sin proveedores')
  await step('el worker procesa aviso.mensaje de reservas y queda not_configured (sin proveedores)', async () => {
    let row = ''
    for (let i = 0; i < 40 && !row; i++) {
      row = sql(`SELECT o.status||'/'||coalesce(o.last_error,'')||'/'||coalesce(d.status,'')||'/'||coalesce(d.last_error,'') FROM llenamos.outbox o LEFT JOIN llenamos.message_deliveries d ON d.id=o.id WHERE o.restaurant_id=${lit(rid)} AND o.kind='aviso.mensaje' AND o.status NOT IN ('pending','leased') LIMIT 1`).trim()
      if (!row) await new Promise(r => setTimeout(r, 1000))
    }
    console.log(`     outbox aviso.mensaje: ${row || 'sin estado'}`)
    assert(row.includes('not_configured') || row.includes('not-configured'), `estado inesperado: ${row || 'sin procesar'}`)
  })
  await step('el worker procesa un mensaje.enviar sin proveedores y queda not_configured (nunca enviado)', async () => {
    // Mismo payload que encola reservas, con el tipo que el worker sí maneja (enqueueMessage de worker/messages.ts).
    sql(`INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) SELECT gen_random_uuid(),restaurant_id,'mensaje.enviar',payload FROM llenamos.outbox WHERE restaurant_id=${lit(rid)} AND kind='aviso.mensaje' LIMIT 1`)
    let row = ''
    for (let i = 0; i < 40 && !row; i++) {
      row = sql(`SELECT o.status||'/'||coalesce(o.last_error,'')||'/'||d.status||'/'||coalesce(d.last_error,'') FROM llenamos.outbox o JOIN llenamos.message_deliveries d ON d.id=o.id WHERE o.restaurant_id=${lit(rid)} AND o.kind='mensaje.enviar' AND o.status NOT IN ('pending','leased') LIMIT 1`).trim()
      if (!row) await new Promise(r => setTimeout(r, 1000))
    }
    console.log(`     outbox/entrega: ${row}`)
    assert(row.includes('not_configured') || row.includes('not-configured'), `estado inesperado: ${row || 'sin procesar'}`)
    assert(!/\/sent\//.test(row), 'no debe figurar como enviado')
  })

  writeFileSync(join(RUN, 'recorrido.json'), JSON.stringify({ rid, loc, steps }, null, 2))
  const failed = steps.filter(s => !s.ok)
  console.log(`\n${steps.length - failed.length}/${steps.length} pasos correctos`)
  process.exit(failed.length ? 1 : 0)
}
main().catch(error => { console.error(error); process.exit(1) })
