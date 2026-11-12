import { writeReservationMarketing } from './fase5/reservation-integration'
import { providerAvailability } from './providers/tenant'
import { configuredAppOrigin } from './public-app-url'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { FieldValue, Timestamp, type Transaction } from 'firebase-admin/firestore'
import { onCall, HttpsError, type CallableRequest } from './identity-call'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { db, options, parse, safe, stamp, uidOf, membership, reservationLock } from './shared'
import { enqueueMessage } from './messages/enqueue'
import { enqueueReservationEvent } from './fase6-api/events'
import { offeredOccupancy } from './waitlist/occupancy'
import { readServiceSessions, serviceOccupancy } from './fase2/occupancy'
import { prepareSeatReservation, prepareFinishReservation, checkReservationPosLock } from './fase2/sessions'

type R1Name = Exclude<keyof typeof core.CALLABLE_SCHEMAS, 'apuntarseListaEspera' | 'aceptarOfertaListaEspera' | 'iniciarPagoSenal' | 'procesarMensajesPendientes'>
function callable<N extends R1Name>(name: N, work: (data: z.output<(typeof core.CALLABLE_SCHEMAS)[N]['input']>, request: CallableRequest<unknown>) => Promise<unknown>) {
  const schemas = core.CALLABLE_SCHEMAS[core.CALLABLES[name]]
  return onCall(options, request => safe(async () => {
    const data = parse(schemas.input as unknown as z.ZodType<z.output<(typeof core.CALLABLE_SCHEMAS)[N]['input']>>, request.data)
    return schemas.output.parse(await work(data, request))
  }))
}
const failure = (message: string): never => { throw new HttpsError('failed-precondition', message) }

async function restaurantId(tx: Transaction, slug: string) {
  const rows = await tx.get(db.collection('restaurants').where('slug', '==', slug).limit(1))
  if (rows.empty) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  return rows.docs[0]!.id
}

/** Todas las lecturas preceden a las escrituras. Un documento privado serializa operaciones. */
async function context(tx: Transaction, rid: string, lid: string, request?: CallableRequest<unknown>, permission: core.Permission = 'reservas.gestionar', publicBooking = false) {
  const root = db.doc(`restaurants/${rid}`)
  const local = root.collection('locations').doc(lid)
  const restaurant = (await tx.get(root)).data()
  if (!restaurant) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  if (!core.hasModule(restaurant, 'reservations')) failure('El módulo de reservas está desactivado.')
  if (request) {
    const member = await membership(tx, rid, uidOf(request))
    if (!member.active || !core.can(member.role, permission) || (member.locationIds.length && !member.locationIds.includes(lid)))
      throw new HttpsError('permission-denied', 'No tienes permiso para gestionar las reservas de este local.')
  }
  const location = await tx.get(local)
  if (!location.exists) throw new HttpsError('not-found', 'No se encuentra el local.')
  const incrementLock = await reservationLock(tx, local.path)
  const settingsDoc = await tx.get(local.collection('settings').doc('reservations'))
  const settings = settingsDoc.exists ? core.ReservationSettingsSchema.parse(settingsDoc.data()) : core.defaultReservationSettings(restaurant.timezone)
  if (publicBooking && !settings.publicBooking) failure('El local no acepta reservas por la web.')
  const tables = (await tx.get(local.collection('tables'))).docs.map(d => core.tableToMesa(d.id, core.TableSchema.parse(d.data())))
  const reservations = (await tx.get(local.collection('reservations'))).docs.map(d => ({ id: d.id, ...core.ReservationSchema.parse(d.data()) }))
  const waitlist = (await tx.get(local.collection('waitlist'))).docs.map(d => ({ id: d.id, ...core.WaitlistEntrySchema.parse(d.data()) }))
  const now = Date.now()
  const sessions = await readServiceSessions(tx, local.path)
  // Las ofertas vigentes también guardan capacidad hasta que caduquen.
  const occupancy = [...serviceOccupancy(reservations, sessions, settings, now), ...waitlist.flatMap(w => offeredOccupancy(w.id, w, settings, now))]
  return { rid, lid, root, local, restaurant, location: location.data()!, settings, config: core.settingsToConfiguracion(settings), tables, reservations, occupancy, now, incrementLock }
}
type Context = Awaited<ReturnType<typeof context>>
function lock(tx: Transaction, c: Context) { c.incrementLock() }
function find(c: Context, id: string) {
  const r = c.reservations.find(r => r.id === id)
  if (!r) throw new HttpsError('not-found', 'No se encuentra la reserva.')
  return r
}
function proposals(c: Context, startAt: number, partySize: number, durationMinutes?: number, reservationId?: string, preferredAreaId?: string | null, limit = 10000) {
  return core.proponerMesas({ config: c.config, mesas: c.tables, reservas: c.occupancy, ahora: c.now, peticion: { inicio: startAt, comensales: partySize, duracionMinutos: durationMinutes, reservaId: reservationId, zonaPreferida: preferredAreaId }, limite: limit })
}
function selection(c: Context, r: Pick<core.Reservation, 'startAt' | 'partySize' | 'durationMinutes'>, tableIds: string[], id?: string) {
  const result = proposals(c, r.startAt, r.partySize, r.durationMinutes, id)
  if (!result.propuestas.length) failure('No queda sitio para esta reserva.')
  if (tableIds.length && !result.propuestas.some(p => p.mesaIds.length === tableIds.length && p.mesaIds.every(t => tableIds.includes(t)))) failure('Las mesas elegidas no están disponibles o no admiten al grupo.')
  return result.propuestas[0]!
}
function availability(c: Context, date: string, partySize: number, durationMinutes?: number, skip = false, exclude?: string) {
  return core.calcularDisponibilidad({ config: c.config, fecha: date, comensales: partySize, mesas: c.tables, reservas: c.occupancy, ahora: c.now, duracionMinutos: durationMinutes, ignorarLimitesPublicos: skip, excluirReservaId: exclude })
}
function start(c: Context, date: string, time: string, partySize: number, durationMinutes?: number, skip = false, exclude?: string) {
  const slot = core.slotStartAt(c.config, date, time)
  if (!slot) failure('Esa hora no existe en la zona horaria del local.')
  const available = availability(c, date, partySize, durationMinutes, skip, exclude)
  if (slot!.inShift ? !available.franjas.some(f => f.inicio === slot!.startAt && f.disponible) : !skip) failure('Esa franja ya no está disponible.')
  return slot!.startAt
}

/** El token claro solo vive en la respuesta y en el enlace del mensaje, nunca en la reserva. */
function notices(tx: Transaction, c: Context, id: string, r: core.Reservation, token?: string) {
  const data: core.MessageData = { guestName: r.guestName, restaurantName: c.restaurant.name, locationName: c.location.name, reference: r.reference, startAt: r.startAt, partySize: r.partySize, timezone: c.settings.timezone, amountCents: r.deposit.amountCents, slug: c.restaurant.slug, locationId: c.lid }
  if (token) data.manageUrl = new URL(`/r/${c.restaurant.slug}/reserva/${r.reference}?t=${token}`, configuredAppOrigin()).href
  const send = (template: core.MessageTemplate, sendAt: number) => {
    for (const channel of ['whatsapp', 'email'] as const) {
      const to = channel === 'email' ? r.email : r.phone
      if (to) enqueueMessage(tx, c.rid, { channel, to, template, language: r.language, data, reservationId: id, waitlistId: null, sendAt })
    }
  }
  if (r.status === 'cancelled') { send('cancellation', c.now); return }
  if (!['pending', 'confirmed'].includes(r.status)) return
  send(r.status === 'confirmed' ? 'confirmation' : 'pending', c.now)
  if (r.deposit.status === 'required') send('deposit_request', c.now)
  if (c.settings.reminders.dayBefore) {
    const day = core.sumarDias(core.horaLocal(r.startAt, c.settings.timezone).fecha, -1)
    const at = core.instanteDeHoraLocal(day, core.horaAMinutos(c.settings.reminders.hour), c.settings.timezone)
    if (at !== null && at > c.now && at < r.startAt) send('reminder', at)
  }
}
async function pendingMessages(tx: Transaction, c: Context, id: string) {
  return (await tx.get(c.root.collection('messages').where('reservationId', '==', id))).docs.filter(d => d.data().status === 'queued')
}
function write(tx: Transaction, c: Context, id: string, r: core.Reservation, fresh = false, actorUid: string | null = null) {
  tx.set(c.local.collection('reservations').doc(id), { ...core.reservationForWrite(core.ReservationSchema.parse(r), Timestamp.fromMillis), updatedBy: actorUid, ...(fresh ? stamp() : { updatedAt: FieldValue.serverTimestamp() }) }, { merge: true })
  lock(tx, c)
}

type NewReservation = { guestName: string; phone: string; email: string | null; language: core.Language; partySize: number; date: string; time: string; source: core.ReservationSource; status?: core.ReservationStatus; durationMinutes?: number; tableIds?: string[]; notes?: string; guestNotes?: string; skipWebLimits?: boolean; attribution?: core.ReservationAttributionInput; marketingOptIn?: core.PublicMarketingOptIn }
async function create(tx: Transaction, c: Context, input: NewReservation, uid: string | null, publicRequest = false, dryRun = false) {
  const startAt = start(c, input.date, input.time, input.partySize, input.durationMinutes, input.skipWebLimits ?? false)
  const amountCents = publicRequest ? core.depositAmountFor(c.settings.deposit, input.partySize) : 0
  const status = publicRequest ? (amountCents || !c.settings.autoConfirm ? 'pending' : 'confirmed') : input.status ?? 'confirmed'
  const token = core.linkToken(randomBytes(32))
  const reference = core.reservationReference(randomBytes(16))
  const ref = c.root.collection('reservationReferences').doc(reference)
  if ((await tx.get(ref)).exists) throw new HttpsError('aborted', 'Repite la operación para obtener otra referencia.')
  const id = c.local.collection('reservations').doc().id
  const providers = await providerAvailability(tx, c.rid)
  const r: core.Reservation = { guestName: input.guestName, phone: input.phone, email: input.email, language: input.language, partySize: input.partySize, startAt, durationMinutes: input.durationMinutes ?? core.duracionParaGrupo(c.config, input.partySize), status, tableIds: input.tableIds ?? [], suggestedTableIds: [], suggestionReason: null, source: input.source, notes: input.notes ?? '', guestNotes: input.guestNotes ?? '', customerId: core.customerIdFor(c.rid, input.phone), reference, manageTokenHash: core.sha256Hex(token), deposit: { status: amountCents ? (providers.stripe ? 'required' : 'not_configured') : 'none', amountCents, checkoutSessionId: null }, history: [], createdBy: uid }
  if (core.occupiesTable(status)) {
    const suggestion = selection(c, r, r.tableIds)
    r.suggestedTableIds = suggestion.mesaIds
    r.suggestionReason = suggestion.explicacion
  }
  if (!dryRun) {
    writeReservationMarketing(tx, c.rid, c.lid, id, r, input.date, c.now, publicRequest ? input : undefined)
    tx.create(ref, { locationId: c.lid, reservationId: id })
    write(tx, c, id, r, true, uid)
    notices(tx, c, id, r, token)
    enqueueReservationEvent(tx, { restaurantId: c.rid, locationId: c.lid, type: 'reservation.created', reservationId: id, status, decision: 'created', at: c.now })
  }
  return { reservationId: id, reference, status, startAt, tableIds: r.tableIds, suggestedTableIds: r.suggestedTableIds, manageToken: token, deposit: r.deposit }
}

export const consultarDisponibilidad = callable('consultarDisponibilidad', d => db.runTransaction(async tx => {
  const c = await context(tx, await restaurantId(tx, d.slug), d.locationId, undefined, undefined, true)
  return core.disponibilidadToOutput(availability(c, d.date, d.partySize), { timezone: c.settings.timezone, waitlistEnabled: c.settings.waitlist.enabled })
}))
export const crearReservaPublica = callable('crearReservaPublica', d => db.runTransaction(async tx => create(tx, await context(tx, await restaurantId(tx, d.slug), d.locationId, undefined, undefined, true), d, null, true)))
export const crearReserva = callable('crearReserva', (d, req) => db.runTransaction(async tx => create(tx, await context(tx, d.restaurantId, d.locationId, req), d, uidOf(req))))

async function linked(tx: Transaction, d: { slug: string; reference: string; token: string }) {
  const rid = await restaurantId(tx, d.slug)
  const ref = (await tx.get(db.doc(`restaurants/${rid}/reservationReferences/${d.reference}`))).data()
  if (!ref) throw new HttpsError('not-found', 'El enlace de reserva no es válido.')
  const c = await context(tx, rid, ref.locationId)
  const r = find(c, ref.reservationId)
  if (!timingSafeEqual(Buffer.from(r.manageTokenHash), Buffer.from(core.sha256Hex(d.token)))) throw new HttpsError('permission-denied', 'El enlace de reserva no es válido.')
  return { c, r }
}
function view(c: Context, r: core.Reservation) {
  const unpaid = ['required', 'not_configured', 'failed'].includes(r.deposit.status)
  return { ...r, timezone: c.settings.timezone, locationId: c.lid, locationName: c.location.name, freeCancellationUntil: c.settings.cancellation.freeUntilHours ? r.startAt - c.settings.cancellation.freeUntilHours * 3600000 : null, canConfirm: !unpaid && core.canTransition(r.status, 'confirmed', r.startAt, c.now), canCancel: core.canTransition(r.status, 'cancelled', r.startAt, c.now) }
}
async function change(tx: Transaction, c: Context, r: core.ReservationWithId, status: core.ReservationStatus, by: string | null, reason?: string | null) {
  const changed = core.applyStatusChange(r, status, { nowMs: c.now, by, reason })
  if (!changed.ok) failure(changed.reason)
  const next = changed.ok ? changed.reservation : r
  if (core.occupiesTable(status)) selection(c, next, next.tableIds, r.id)
  const pending = await pendingMessages(tx, c, r.id)
  for (const doc of pending) tx.update(doc.ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
  write(tx, c, r.id, next, false, by)
  if (status === 'confirmed' || status === 'cancelled') notices(tx, c, r.id, next)
  enqueueReservationEvent(tx, { restaurantId: c.rid, locationId: c.lid, type: 'reservation.statusChanged', reservationId: r.id, status, decision: next.history.length, at: c.now })
  return next
}
export const verReservaPublica = callable('verReservaPublica', d => db.runTransaction(async tx => { const { c, r } = await linked(tx, d); return view(c, r) }))
export const gestionarReservaPublica = callable('gestionarReservaPublica', d => db.runTransaction(async tx => {
  const { c, r } = await linked(tx, d)
  if (d.action === 'confirm' && !view(c, r).canConfirm) failure('La reserva no se puede confirmar; comprueba la señal pendiente.')
  return view(c, await change(tx, c, r, d.action === 'confirm' ? 'confirmed' : 'cancelled', null, d.reason))
}))
export const cambiarEstadoReserva = callable('cambiarEstadoReserva', (d, req) => db.runTransaction(async tx => {
  const c = await context(tx, d.restaurantId, d.locationId, req)
  const open = d.status === 'seated' && core.hasModule(c.restaurant, 'floor')
    ? await prepareSeatReservation(tx, d.restaurantId, d.locationId, d.reservationId, req) : null
  const close = d.status === 'finished' && core.hasModule(c.restaurant, 'floor')
    ? await prepareFinishReservation(tx,d.restaurantId,d.locationId,d.reservationId,req) : null
  if (!(open && find(c, d.reservationId).status === 'seated')) await change(tx, c, find(c, d.reservationId), d.status, uidOf(req), d.reason)
  open?.()
  close?.()
  return { ok: true, status: d.status }
}))
export const asignarMesas = callable('asignarMesas', (d, req) => db.runTransaction(async tx => {
  const c = await context(tx, d.restaurantId, d.locationId, req)
  const r = find(c, d.reservationId)
  await checkReservationPosLock(tx,d.restaurantId,d.locationId,d.reservationId)
  if (!core.occupiesTable(r.status)) failure('Esta reserva ya no ocupa mesa.')
  selection(c, r, d.tableIds, r.id)
  write(tx, c, r.id, { ...r, tableIds: d.tableIds }, false, uidOf(req))
  return { ok: true, tableIds: d.tableIds }
}))
export const moverReserva = callable('moverReserva', (d, req) => db.runTransaction(async tx => {
  const c = await context(tx, d.restaurantId, d.locationId, req)
  const old = find(c, d.reservationId)
  if (!['pending', 'confirmed'].includes(old.status)) failure('Solo se pueden mover reservas pendientes o confirmadas.')
  const partySize = d.partySize ?? old.partySize
  const durationMinutes = d.durationMinutes ?? core.duracionParaGrupo(c.config, partySize)
  const r = { ...old, partySize, durationMinutes, startAt: start(c, d.date, d.time, partySize, durationMinutes, true, old.id), tableIds: d.tableIds ?? old.tableIds }
  const p = proposals(c, r.startAt, partySize, durationMinutes, old.id)
  if (d.tableIds === undefined && !p.propuestas.some(p => p.mesaIds.length === r.tableIds.length && p.mesaIds.every(t => r.tableIds.includes(t)))) r.tableIds = []
  const suggestion = selection(c, r, r.tableIds, old.id)
  r.suggestedTableIds = suggestion.mesaIds; r.suggestionReason = suggestion.explicacion
  const pending = await pendingMessages(tx, c, r.id)
  for (const doc of pending) tx.update(doc.ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
  write(tx, c, r.id, r, false, uidOf(req)); notices(tx, c, r.id, r)
  return { ok: true, ...r }
}))
export const proponerMesasReserva = callable('proponerMesasReserva', (d, req) => db.runTransaction(async tx => {
  const c = await context(tx, d.restaurantId, d.locationId, req)
  const r = d.reservationId ? find(c, d.reservationId) : undefined
  const wall = r ? core.horaLocal(r.startAt, c.settings.timezone) : undefined
  const startAt = d.date || d.time ? core.slotStartAt(c.config, d.date ?? wall!.fecha, d.time ?? core.minutosAHora(wall!.minutos))?.startAt : r?.startAt
  if (startAt === undefined) failure('Indica una fecha y hora válidas.')
  return core.asignacionToOutput(proposals(c, startAt!, d.partySize ?? r!.partySize, d.durationMinutes ?? r?.durationMinutes, r?.id, d.preferredAreaId, d.limit))
}))
export const guardarConfiguracionReservas = callable('guardarConfiguracionReservas', (d, req) => db.runTransaction(async tx => {
  const c = await context(tx, d.restaurantId, d.locationId, req, 'reservas.configurar')
  tx.set(c.local.collection('settings').doc('reservations'), { ...d.settings, ...stamp(), updatedBy: uidOf(req) }); lock(tx, c)
  return { ok: true }
}))
export const cambiarPlan = callable('cambiarPlan', (d, req) => db.runTransaction(async tx => {
  uidOf(req, true)
  if (req.auth?.token.logiqd !== true) throw new HttpsError('permission-denied', 'Solo el equipo de LogiQD puede cambiar el plan.')
  const ref = db.doc(`restaurants/${d.restaurantId}`)
  const restaurant = await tx.get(ref)
  if (!restaurant.exists) throw new HttpsError('not-found', 'No se encuentra el restaurante.')
  if (restaurant.get('entitlementVersion')) throw new HttpsError('failed-precondition', 'Este restaurante usa planes de plataforma. Revisa su suscripción y sus excepciones')
  const activeModules = core.activeModulesFor(d.plan, d.moduleOverrides)
  tx.update(ref, { plan: d.plan, moduleOverrides: d.moduleOverrides, activeModules, updatedAt: FieldValue.serverTimestamp() })
  return { ok: true, plan: d.plan, activeModules }
}))
export const importarReservas = callable('importarReservas', async (d, req) => {
  await db.runTransaction(tx => context(tx, d.restaurantId, d.locationId, req, 'reservas.importar'))
  const errors: core.ImportRowError[] = [], reservationIds: string[] = []
  // Cada fila es una transacción independiente: un fallo no revierte las filas correctas.
  for (const [index, raw] of d.rows.entries()) {
    const row = core.parseImportRow(raw, index)
    if (!row.ok) { errors.push(...row.errors); continue }
    try {
      const result = await db.runTransaction(async tx => {
        const c = await context(tx, d.restaurantId, d.locationId, req, 'reservas.importar')
        const tableIds = row.value.tables.map(name => {
          const table = c.tables.find(t => t.name === name)
          if (!table) failure(`No existe la mesa ${name}.`)
          return table!.id
        })
        return create(tx, c, { ...row.value, source: 'import', skipWebLimits: true, tableIds }, uidOf(req), false, d.dryRun)
      })
      if (!d.dryRun) reservationIds.push(result.reservationId)
    } catch (error) {
      if (error instanceof HttpsError && ['unauthenticated', 'permission-denied'].includes(error.code)) throw error
      errors.push({ row: index, field: null, message: error instanceof HttpsError ? error.message : 'No se ha podido importar la fila.' })
    }
  }
  return { created: reservationIds.length, reservationIds, errors }
})

/** Los webhooks usan la misma responsabilidad transaccional de avisos que R1. */
export async function prepareReservationNotices(tx: Transaction, rid: string, lid: string, id: string, r: core.Reservation) {
  const c = await context(tx, rid, lid)
  const pending = await pendingMessages(tx, c, id)
  return () => {
    for (const doc of pending) tx.update(doc.ref, { status: 'cancelled', updatedAt: FieldValue.serverTimestamp() })
    if (r.status === 'confirmed' || r.status === 'cancelled') notices(tx, c, id, r)
  }
}
