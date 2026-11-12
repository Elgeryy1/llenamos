import {
  BillPartSchema,
  BillSchema,
  CALLABLES,
  CALLABLE_SCHEMAS,
  CALLABLE_SCHEMAS_FASE2,
  CALLABLE_SCHEMAS_FASE3,
  CashMovementSchema,
  CashSessionSchema,
  CustomerSchema,
  DailyMenuSchema,
  FASE2_ACCESS,
  FASE3_ACCESS,
  FISCAL_TEST_WARNING,
  FiscalChainSchema,
  FiscalStoredRecordSchema,
  FloorSettingsSchema,
  FloorTaskSchema,
  InvoiceSchema,
  InvoiceSeriesSchema,
  MemberSchema,
  MenuCategorySchema,
  MenuItemSchema,
  MessageRequestSchema,
  MessageSchema,
  MobileCheckoutSchema,
  OrderLineSchema,
  OrderSchema,
  PaymentReservationSchema,
  PaymentSchema,
  PosSettingsSchema,
  PublicLocationSchema,
  PublicMenuSchema,
  PublicRestaurantSchema,
  RESERVATION_STATUS_LABEL,
  ROLE_LABEL,
  ReservationSchema,
  ReservationSettingsSchema,
  RestaurantSchema,
  RoleSchema,
  StationSchema,
  TableSchema,
  TableSessionSchema,
  TakeawaySchema,
  TipDistributionSchema,
  WaitlistEntrySchema,
  __export,
  activeModulesFor,
  applyLineStatus,
  applyStatusChange,
  asignacionToOutput,
  auth,
  authorize,
  authorizeInvitation,
  autoFireAfterServe,
  billForWrite,
  billLinesFromOrderLines,
  buildPublicMenu,
  calcularDisponibilidad,
  can,
  canSessionTransition,
  canTakeawayTransition,
  canTransition,
  cancelTask,
  cashChange,
  cashMovementForWrite,
  cashReconciliation,
  cashSessionForWrite,
  checkCancelSession,
  checkCharge,
  checkCloseSession,
  checkLineTransition,
  checkRefund,
  choquesDeMesa,
  claimTask,
  combinacionesDeMesas,
  completeTask,
  construirOcupacion,
  createTestFiscalProvider,
  customerForWrite,
  customerIdFor,
  db,
  defaultFloorSettings,
  defaultReservationSettings,
  depositAmountFor,
  disponibilidadToOutput,
  distributeTips,
  dueTakeawayLines,
  duracionParaGrupo,
  encajarSolicitudes,
  ensureOwner,
  external_exports,
  findPickupSlot,
  firingFor,
  fiscalIdentity,
  fiscalOutboxForWrite,
  floorTaskForWrite,
  hasModule,
  horaAMinutos,
  horaLocal,
  id,
  instanteDeHoraLocal,
  invoiceIdentity,
  invoiceLinesForPart,
  invoiceTotals,
  lineTransitionPermissions,
  linesToFire,
  linkToken,
  membership,
  menuLineStatus,
  messageForWrite,
  minutosAHora,
  mobileCheckoutForWrite,
  netBillLines,
  nextDailyMenuVersion,
  nextHeldCourse,
  nextInvoiceNumber,
  nextItemVersion,
  occupiesTable,
  opcionesParaGrupo,
  options,
  orderForWrite,
  orderLineForWrite,
  parse,
  parseImportRow,
  paymentForWrite,
  paymentReservationForWrite,
  pickupSlots,
  planJoin,
  planMove,
  planOpen,
  planOrderLines,
  planSplit,
  priceOrder,
  printRequestForWrite,
  proponerMesas,
  publicLineStatus,
  publicMenuCatalog,
  publicMenuId,
  queuedMessage,
  readyForPickup,
  rectifyInvoice,
  releaseTask,
  renderMessage,
  reservationForWrite,
  reservationLock,
  reservationReference,
  reservationToOcupacion,
  resolveStation,
  safe,
  sessionFromReservation,
  sessionIsOpen,
  sessionLabel,
  sessionToOcupacion,
  sessionTotals,
  settingsToConfiguracion,
  sha256Hex,
  slotStartAt,
  slugify,
  solicitudesSinMesa,
  splitBill,
  stamp,
  sumCents,
  sumarDias,
  tableQrPath,
  tableSessionForWrite,
  tableToMesa,
  tablesAreJoinable,
  takeawayFiring,
  takeawayForWrite,
  takeawayLabel,
  takeawayStatusFromLines,
  taskDedupeKey,
  taskDueAt,
  taskIsActive,
  timestampToMillis,
  tipDistributionForWrite,
  uidOf,
  verifyFiscalChain,
  waitlistEntryForWrite
} from "./chunk-US6TOM4Y.js";

// src/crearRestaurante.ts
import { onCall } from "firebase-functions/v2/https";

// src/callableActivity.ts
var roles = (role) => ROLE_LABEL[role].toLowerCase();
function memberActivity(actor, target, action, role) {
  const descriptions = {
    invited: `ha invitado a ${target.displayName} con el rol de ${roles(role)}`,
    reactivated: `ha reactivado a ${target.displayName} con el rol de ${roles(role)}`,
    roleChanged: `ha cambiado el rol de ${target.displayName} a ${roles(role)}`,
    deactivated: `ha desactivado a ${target.displayName}`
  };
  return { action: `member.${action}`, summary: `${actor.displayName} ${descriptions[action]}`, actorUid: actor.uid, actorName: actor.displayName, entity: { type: "member", id: target.uid } };
}
function recordActivity(tx, ref, data) {
  tx.create(ref, { ...data, ...stamp() });
}

// src/crearRestaurante.ts
var crearRestaurante = onCall(options, (request) => safe(async () => {
  const uid = uidOf(request);
  const input = parse(external_exports.object({ name: external_exports.string().trim().min(2).max(80), locationName: external_exports.string().trim().min(2).max(80) }).strict(), request.data);
  const user = await auth.getUser(uid);
  const restaurant = db.collection("restaurants").doc();
  const location = restaurant.collection("locations").doc();
  const activity = restaurant.collection("activity").doc();
  const memberLog = restaurant.collection("activity").doc();
  const actor = { uid, displayName: user.displayName || user.email || "Propietario" };
  await db.runTransaction(async (tx) => {
    const profile = await tx.get(db.doc(`users/${uid}`));
    tx.create(restaurant, { changeId: activity.id, name: input.name, slug: slugify(input.name) || restaurant.id, brandColor: "#f0a35e", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: false, ...stamp() });
    tx.create(location, { name: input.locationName, slug: slugify(input.locationName) || location.id, address: "", city: "", phone: "", ...stamp() });
    tx.create(restaurant.collection("members").doc(uid), { changeId: memberLog.id, uid, displayName: user.displayName || user.email || "Propietario", email: user.email || "", role: "owner", locationIds: [], active: true, ...stamp() });
    recordActivity(tx, activity, { action: "restaurant.created", summary: `${actor.displayName} ha creado el restaurante ${input.name}`, actorUid: uid, actorName: actor.displayName, entity: { type: "restaurant", id: restaurant.id } });
    recordActivity(tx, memberLog, memberActivity(actor, actor, "invited", "owner"));
    tx.set(profile.ref, { displayName: user.displayName || user.email || "Propietario", email: user.email || "", restaurants: { [restaurant.id]: { name: input.name, role: "owner" } }, ...profile.exists ? {} : { createdAt: stamp().createdAt }, updatedAt: stamp().updatedAt }, { merge: true });
  });
  return { restaurantId: restaurant.id, locationId: location.id };
}));

// src/invitarMiembro.ts
import { HttpsError, onCall as onCall2 } from "firebase-functions/v2/https";
var invitarMiembro = onCall2(options, (request) => safe(async () => {
  const actorUid = uidOf(request);
  const input = parse(external_exports.object({ restaurantId: id, email: external_exports.string().trim().email().transform((v) => v.toLowerCase()), displayName: external_exports.string().trim().min(1).max(80), role: RoleSchema, password: external_exports.string().min(8).max(128) }).strict(), request.data);
  await db.runTransaction(async (tx) => {
    authorize(await membership(tx, input.restaurantId, actorUid), void 0, input.role);
  });
  const user = await auth.getUserByEmail(input.email).catch((error) => {
    if (error.code !== "auth/user-not-found") throw error;
    return auth.createUser({ email: input.email, password: input.password, displayName: input.displayName });
  });
  await db.runTransaction(async (tx) => {
    const actor = await membership(tx, input.restaurantId, actorUid);
    authorize(actor, void 0, input.role);
    const restaurant = await tx.get(db.doc(`restaurants/${input.restaurantId}`));
    const member = await tx.get(restaurant.ref.collection("members").doc(user.uid));
    const profile = await tx.get(db.doc(`users/${user.uid}`));
    if (!restaurant.exists) throw new HttpsError("not-found", "El restaurante no existe.");
    const target = member.exists ? MemberSchema.parse(member.data()) : void 0;
    authorizeInvitation(actor, target, input.role);
    const activity = restaurant.ref.collection("activity").doc();
    tx.set(member.ref, { changeId: activity.id, uid: user.uid, email: input.email, displayName: input.displayName, role: input.role, locationIds: [], active: true, ...stamp(), ...target ? { createdAt: member.data().createdAt, locationIds: target.locationIds } : {} });
    recordActivity(tx, activity, memberActivity(actor, { uid: user.uid, displayName: input.displayName }, target ? "reactivated" : "invited", input.role));
    tx.set(profile.ref, { displayName: profile.data()?.displayName ?? user.displayName ?? input.displayName, email: input.email, restaurants: { [input.restaurantId]: { name: restaurant.data().name, role: input.role } }, ...profile.exists ? {} : { createdAt: stamp().createdAt }, updatedAt: stamp().updatedAt }, { merge: true });
    tx.update(restaurant.ref, { updatedAt: stamp().updatedAt });
  });
  return { uid: user.uid };
}));

// src/cambiarRolMiembro.ts
import { onCall as onCall3 } from "firebase-functions/v2/https";

// src/changeMembership.ts
import { FieldValue } from "firebase-admin/firestore";
import { HttpsError as HttpsError2 } from "firebase-functions/v2/https";
async function changeMembership(rid, actorUid, uid, role) {
  await db.runTransaction(async (tx) => {
    const actor = await membership(tx, rid, actorUid);
    const target = await membership(tx, rid, uid);
    authorize(actor, target, role);
    const restaurant = await tx.get(db.doc(`restaurants/${rid}`));
    const owners = await tx.get(restaurant.ref.collection("members").where("role", "==", "owner").where("active", "==", true));
    const profile = await tx.get(db.doc(`users/${uid}`));
    if (!restaurant.exists) throw new HttpsError2("not-found", "El restaurante no existe.");
    const nextRole = role ?? target.role;
    const active = role ? target.active : false;
    ensureOwner(target, nextRole, active, owners.size);
    const activity = restaurant.ref.collection("activity").doc();
    recordActivity(tx, activity, memberActivity(actor, target, role ? "roleChanged" : "deactivated", nextRole));
    tx.update(restaurant.ref.collection("members").doc(uid), { changeId: activity.id, role: nextRole, active, updatedAt: stamp().updatedAt });
    tx.set(profile.ref, { ...profile.exists ? {} : { displayName: target.displayName, email: target.email, createdAt: stamp().createdAt }, restaurants: { [rid]: active ? { name: restaurant.data().name, role: nextRole } : FieldValue.delete() }, updatedAt: stamp().updatedAt }, { merge: true });
    tx.update(restaurant.ref, { updatedAt: stamp().updatedAt });
  });
  return { ok: true };
}

// src/cambiarRolMiembro.ts
var cambiarRolMiembro = onCall3(options, (request) => safe(async () => {
  const actor = uidOf(request);
  const input = parse(external_exports.object({ restaurantId: id, uid: id, role: RoleSchema }).strict(), request.data);
  return changeMembership(input.restaurantId, actor, input.uid, input.role);
}));

// src/desactivarMiembro.ts
import { onCall as onCall4 } from "firebase-functions/v2/https";
var desactivarMiembro = onCall4(options, (request) => safe(async () => {
  const actor = uidOf(request);
  const input = parse(external_exports.object({ restaurantId: id, uid: id }).strict(), request.data);
  return changeMembership(input.restaurantId, actor, input.uid);
}));

// src/activityRestaurant.ts
import { onDocumentWrittenWithAuthContext } from "firebase-functions/v2/firestore";

// src/activity.ts
import { createHash } from "crypto";
async function writeActivity(event, type, entityId) {
  if (!event.data) return;
  const before = event.data.before.data();
  const after = event.data.after.data();
  if (["restaurant", "member"].includes(type) && after?.changeId && after.changeId !== before?.changeId) return;
  const meaningful = (data) => JSON.stringify(Object.fromEntries(Object.entries(data ?? {}).filter(([key]) => !["createdAt", "updatedAt", "changeId", "updatedBy"].includes(key)).sort(([a], [b]) => a.localeCompare(b))));
  if (meaningful(before) === meaningful(after)) return;
  const action = !before ? "created" : !after ? "deleted" : "updated";
  const updatedBy = (after ?? before)?.updatedBy;
  const actorUid = (event.authType === "api_key" && event.authId ? event.authId : null) ?? (typeof updatedBy === "string" && updatedBy.length > 0 && !updatedBy.includes("/") ? updatedBy : null);
  const actor = actorUid ? await db.doc(`users/${actorUid}`).get() : null;
  const labels = { restaurant: "Restaurante", member: "Miembro", area: "Zona", table: "Mesa" };
  const feminine = ["area", "table"].includes(type);
  const verbs = { created: "creado", deleted: "eliminado", updated: "actualizado" };
  const verb = feminine ? verbs[action].replace(/o$/, "a") : verbs[action];
  const ref = db.doc(`restaurants/${event.params.rid}/activity/${createHash("sha256").update(event.id).digest("hex")}`);
  await db.runTransaction(async (tx) => {
    if ((await tx.get(ref)).exists) return;
    tx.create(ref, { action: `${type}.${action}`, summary: `${labels[type]} ${verb}: ${after?.name ?? after?.displayName ?? before?.name ?? before?.displayName ?? entityId}`, actorUid, actorName: actor?.data()?.displayName ?? null, entity: { type, id: entityId }, ...stamp() });
  });
}

// src/activityRestaurant.ts
var activityRestaurant = onDocumentWrittenWithAuthContext({ document: "restaurants/{rid}", region: "europe-west1" }, (event) => writeActivity(event, "restaurant", event.params.rid));

// src/activityMember.ts
import { onDocumentWrittenWithAuthContext as onDocumentWrittenWithAuthContext2 } from "firebase-functions/v2/firestore";
var activityMember = onDocumentWrittenWithAuthContext2({ document: "restaurants/{rid}/members/{uid}", region: "europe-west1" }, (event) => writeActivity(event, "member", event.params.uid));

// src/activityArea.ts
import { onDocumentWrittenWithAuthContext as onDocumentWrittenWithAuthContext3 } from "firebase-functions/v2/firestore";
var activityArea = onDocumentWrittenWithAuthContext3({ document: "restaurants/{rid}/locations/{lid}/areas/{aid}", region: "europe-west1" }, (event) => writeActivity(event, "area", event.params.aid));

// src/activityTable.ts
import { onDocumentWrittenWithAuthContext as onDocumentWrittenWithAuthContext4 } from "firebase-functions/v2/firestore";
var activityTable = onDocumentWrittenWithAuthContext4({ document: "restaurants/{rid}/locations/{lid}/tables/{tid}", region: "europe-west1" }, (event) => writeActivity(event, "table", event.params.tid));

// src/messages/process.ts
import { randomUUID } from "crypto";
import { FieldValue as FieldValue2, Timestamp as Timestamp4 } from "firebase-admin/firestore";
import { onDocumentCreated } from "firebase-functions/v2/firestore";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { onCall as onCall6, HttpsError as HttpsError5 } from "firebase-functions/v2/https";

// src/messages/lifecycle.ts
import { onDocumentUpdated } from "firebase-functions/v2/firestore";
import { Timestamp as Timestamp3 } from "firebase-admin/firestore";

// src/messages/enqueue.ts
import { Timestamp } from "firebase-admin/firestore";
function enqueueMessage(tx, rid, request, key) {
  const message = MessageSchema.parse(queuedMessage(MessageRequestSchema.parse(request)));
  const collection = db.collection(`restaurants/${rid}/messages`);
  const ref = key ? collection.doc(key) : collection.doc();
  tx.create(ref, { ...messageForWrite(message, Timestamp.fromMillis), ...stamp() });
  return ref.id;
}

// src/messages/support.ts
import { randomBytes } from "crypto";
import { HttpsError as HttpsError3 } from "firebase-functions/v2/https";
var token = () => linkToken(randomBytes(32));
function queue(tx, rid, request, key) {
  return enqueueMessage(tx, rid, request, key);
}
async function publicContext(slug) {
  const pub = parse(PublicRestaurantSchema, (await db.doc(`publicRestaurants/${slug}`).get()).data());
  const restaurant = parse(RestaurantSchema, (await db.doc(`restaurants/${pub.restaurantId}`).get()).data());
  if (!hasModule(restaurant, "reservations") || !pub.bookingEnabled) throw new HttpsError3("failed-precondition", "Las reservas p\xFAblicas est\xE1n desactivadas.");
  return { pub, restaurant, rid: pub.restaurantId };
}
async function settings(path) {
  const snap = await db.doc(`${path}/settings/reservations`).get();
  return snap.exists ? parse(ReservationSettingsSchema, snap.data()) : defaultReservationSettings();
}
async function linkedReservation(rid, reference, hash2) {
  const index = (await db.doc(`restaurants/${rid}/reservationReferences/${reference}`).get()).data();
  if (index) {
    const doc = await db.doc(`restaurants/${rid}/locations/${index.locationId}/reservations/${index.reservationId}`).get();
    if (doc.exists) {
      const r = parse(ReservationSchema, doc.data());
      if (r.manageTokenHash === hash2) return { ref: doc.ref, reservation: r };
    }
  }
  throw new HttpsError3("not-found", "No se encuentra la reserva o el enlace no es v\xE1lido.");
}
async function throttle(tx, rid, customerId, now) {
  const ref = db.doc(`restaurants/${rid}/r2RateLimits/${customerId}`);
  const old = (await tx.get(ref)).data();
  const count = old && now - old.since < 36e5 ? Number(old.count) : 0;
  if (count >= 10) throw new HttpsError3("resource-exhausted", "Demasiados intentos. Vuelve a intentarlo m\xE1s tarde.");
  return () => tx.set(ref, { since: count ? old.since : now, count: count + 1 });
}

// src/waitlist/service.ts
import { randomBytes as randomBytes2 } from "crypto";
import { Timestamp as Timestamp2 } from "firebase-admin/firestore";
import { onCall as onCall5, HttpsError as HttpsError4 } from "firebase-functions/v2/https";

// src/waitlist/occupancy.ts
function offeredOccupancy(id2, entry, settings2, now) {
  if (entry.status !== "offered" || !entry.offer || entry.offer.expiresAt <= now) return [];
  const config = settingsToConfiguracion(settings2);
  const duration = duracionParaGrupo(config, entry.partySize);
  return [{ id: `waitlist-${id2}`, inicio: entry.offer.startAt, duracionMinutos: duration, comensales: entry.partySize, estado: "pendiente", mesaIds: [] }];
}

// src/fase2/occupancy.ts
function representedReservations(sessions) {
  const result = /* @__PURE__ */ new Set();
  for (const session of sessions) {
    let destination2 = session;
    const seen = /* @__PURE__ */ new Set();
    while (destination2.status === "merged" && destination2.mergedInto && !seen.has(destination2.id)) {
      seen.add(destination2.id);
      const next = sessions.find((s) => s.id === destination2.mergedInto);
      if (!next) break;
      destination2 = next;
    }
    if (session.reservationId && (sessionIsOpen(destination2.status) || destination2.status === "closed")) result.add(session.reservationId);
  }
  return result;
}
function serviceOccupancy(reservations, sessions, settings2, now) {
  const represented = representedReservations(sessions), config = settingsToConfiguracion(settings2);
  return [
    ...reservations.filter((r) => !(r.status === "seated" && represented.has(r.id))).map((r) => reservationToOcupacion(r.id, r)),
    ...sessions.flatMap((s) => {
      const occupied = sessionToOcupacion(s.id, s, duracionParaGrupo(config, s.guests));
      return occupied ? [occupied] : [];
    })
  ];
}
async function readServiceSessions(tx, path) {
  const docs = await tx.get(db.collection(`${path}/tableSessions`));
  return docs.docs.map((d) => ({ ...TableSessionSchema.parse(d.data()), id: d.id }));
}
function floorOccupancy(c) {
  return [
    ...serviceOccupancy([...c.rows.reservations.values()], [...c.rows.tableSessions.values()], c.reservationSettings, c.now),
    ...[...c.rows.waitlist.values()].flatMap((w) => offeredOccupancy(w.id, w, c.reservationSettings, c.now))
  ];
}

// src/waitlist/service.ts
async function inventory(tx, path, s, now, exclude) {
  const [tables2, reservations, waiting, sessions] = await Promise.all([tx.get(db.collection(`${path}/tables`)), tx.get(db.collection(`${path}/reservations`)), tx.get(db.collection(`${path}/waitlist`)), readServiceSessions(tx, path)]);
  return { tables: tables2.docs.map((d) => tableToMesa(d.id, parse(TableSchema, d.data()))), reservations: [...serviceOccupancy(reservations.docs.map((d) => ({ id: d.id, ...parse(ReservationSchema, d.data()) })), sessions, s, now), ...waiting.docs.filter((d) => d.id !== exclude).flatMap((d) => offeredOccupancy(d.id, parse(WaitlistEntrySchema, d.data()), s, now))], waiting };
}
var apuntarseListaEspera = onCall5(options, (request) => safe(async () => {
  const data = parse(CALLABLE_SCHEMAS[CALLABLES.apuntarseListaEspera].input, request.data);
  const { rid, pub } = await publicContext(data.slug);
  if (!pub.locations.some((l) => l.id === data.locationId)) throw new HttpsError4("not-found", "No se encuentra el local.");
  const path = `restaurants/${rid}/locations/${data.locationId}`;
  const s = await settings(path);
  if (data.partySize < s.minPartySize || data.partySize > s.maxPartySize || data.date < horaLocal(Date.now(), s.timezone).fecha || data.date > sumarDias(horaLocal(Date.now(), s.timezone).fecha, s.maxAdvanceDays)) throw new HttpsError4("invalid-argument", "La fecha o el tama\xF1o del grupo est\xE1n fuera del plazo de reservas.");
  if (!s.waitlist.enabled) throw new HttpsError4("failed-precondition", "La lista de espera est\xE1 desactivada.");
  const customerId = customerIdFor(rid, data.phone);
  const ref = db.collection(`${path}/waitlist`).doc();
  await db.runTransaction(async (tx) => {
    const rate = await throttle(tx, rid, customerId, Date.now());
    const entry = parse(WaitlistEntrySchema, { ...data, customerId, status: "waiting", offer: null });
    rate();
    tx.create(ref, { ...waitlistEntryForWrite(entry, Timestamp2.fromMillis), ...stamp() });
  });
  return { waitlistId: ref.id, status: "waiting" };
}));
async function offerWaitlist(rid, lid) {
  const path = `restaurants/${rid}/locations/${lid}`;
  await db.runTransaction(async (tx) => {
    const incrementLock = await reservationLock(tx, path);
    const [settingsDoc, restaurantDoc] = await Promise.all([tx.get(db.doc(`${path}/settings/reservations`)), tx.get(db.doc(`restaurants/${rid}`))]);
    if (!settingsDoc.exists) return;
    const s = parse(ReservationSettingsSchema, settingsDoc.data());
    const restaurant = parse(RestaurantSchema, restaurantDoc.data());
    if (!s.waitlist.enabled || !s.publicBooking || !hasModule(restaurant, "reservations")) return;
    const now = Date.now(), inv = await inventory(tx, path, s, now);
    const candidates = inv.waiting.docs.filter((d) => d.get("status") === "waiting").sort((a, b) => (a.get("createdAt")?.toMillis() ?? 0) - (b.get("createdAt")?.toMillis() ?? 0) || a.id.localeCompare(b.id));
    for (const doc of candidates) {
      const entry = parse(WaitlistEntrySchema, doc.data());
      const available = calcularDisponibilidad({ config: settingsToConfiguracion(s), fecha: entry.date, comensales: entry.partySize, mesas: inv.tables, reservas: inv.reservations, ahora: now });
      const from = horaAMinutos(entry.from), to = horaAMinutos(entry.to);
      const slot = available.franjas.find((f) => f.disponible && (from <= to ? horaAMinutos(f.hora) >= from && horaAMinutos(f.hora) <= to : horaAMinutos(f.hora) >= from || horaAMinutos(f.hora) <= to));
      if (!slot) continue;
      const raw = token(), expiresAt = now + s.waitlist.offerMinutes * 6e4;
      incrementLock();
      tx.update(doc.ref, { status: "offered", offer: { startAt: Timestamp2.fromMillis(slot.inicio), expiresAt: Timestamp2.fromMillis(expiresAt), tokenHash: sha256Hex(raw) }, updatedAt: Timestamp2.now() });
      const offerUrl = `${process.env.PUBLIC_APP_URL || "http://localhost:3000"}/r/${restaurant.slug}/lista-espera/${doc.id}?t=${raw}`;
      for (const channel of ["email", "whatsapp"]) {
        const to2 = channel === "email" ? entry.email : entry.phone;
        if (to2) queue(tx, rid, { channel, to: to2, template: "waitlist_offer", language: entry.language, data: { guestName: entry.guestName, restaurantName: restaurant.name, partySize: entry.partySize, startAt: slot.inicio, timezone: s.timezone, offerUrl, expiresAt }, reservationId: null, waitlistId: doc.id, sendAt: now }, `offer_${doc.id}_${channel}`);
      }
      break;
    }
  });
}
var aceptarOfertaListaEspera = onCall5(options, (request) => safe(async () => {
  const data = parse(CALLABLE_SCHEMAS[CALLABLES.aceptarOfertaListaEspera].input, request.data);
  const { rid, pub } = await publicContext(data.slug);
  for (const location of pub.locations) {
    const path = `restaurants/${rid}/locations/${location.id}`, ref = db.doc(`${path}/waitlist/${data.waitlistId}`);
    if (!(await ref.get()).exists) continue;
    return db.runTransaction(async (tx) => {
      const incrementLock = await reservationLock(tx, path);
      const [entryDoc, settingsDoc] = await Promise.all([tx.get(ref), tx.get(db.doc(`${path}/settings/reservations`))]);
      const entry = parse(WaitlistEntrySchema, entryDoc.data()), s = parse(ReservationSettingsSchema, settingsDoc.data()), now = Date.now();
      if (entry.status !== "offered" || !entry.offer || entry.offer.tokenHash !== sha256Hex(data.token) || entry.offer.expiresAt <= now) throw new HttpsError4("failed-precondition", "La oferta ha caducado o el enlace no es v\xE1lido.");
      const rate = await throttle(tx, rid, entry.customerId, now);
      const inv = await inventory(tx, path, s, now, ref.id);
      const available = calcularDisponibilidad({ config: settingsToConfiguracion(s), fecha: entry.date, comensales: entry.partySize, mesas: inv.tables, reservas: inv.reservations, ahora: now });
      if (!available.franjas.some((f) => f.inicio === entry.offer.startAt && f.disponible)) throw new HttpsError4("failed-precondition", "El hueco ya no est\xE1 disponible.");
      const reference = reservationReference(randomBytes2(16)), manageToken = token();
      const referenceRef = db.doc(`restaurants/${rid}/reservationReferences/${reference}`);
      if ((await tx.get(referenceRef)).exists) throw new HttpsError4("aborted", "Vuelve a aceptar la oferta.");
      const amountCents = depositAmountFor(s.deposit, entry.partySize);
      const deposit = { status: amountCents ? process.env.STRIPE_SECRET_KEY ? "required" : "not_configured" : "none", amountCents, checkoutSessionId: null };
      const reservation = parse(ReservationSchema, { ...entry, startAt: entry.offer.startAt, durationMinutes: available.duracionMinutos, status: s.autoConfirm && !amountCents ? "confirmed" : "pending", source: "waitlist", tableIds: [], suggestedTableIds: [], suggestionReason: null, notes: "", guestNotes: "", reference, manageTokenHash: sha256Hex(manageToken), deposit, history: [], createdBy: null });
      const reservationRef = db.collection(`${path}/reservations`).doc();
      incrementLock();
      tx.create(referenceRef, { locationId: location.id, reservationId: reservationRef.id });
      rate();
      tx.create(reservationRef, { ...reservationForWrite(reservation, Timestamp2.fromMillis), ...stamp() });
      tx.update(ref, { status: "booked", updatedAt: Timestamp2.now() });
      const manageUrl = `${process.env.PUBLIC_APP_URL || "http://localhost:3000"}/r/${data.slug}/reserva/${reference}?t=${manageToken}`;
      for (const channel of ["email", "whatsapp"]) {
        const to = channel === "email" ? entry.email : entry.phone;
        if (to) queue(tx, rid, { channel, to, template: deposit.status === "required" ? "deposit_request" : reservation.status === "confirmed" ? "confirmation" : "pending", language: entry.language, data: { guestName: entry.guestName, restaurantName: pub.name, partySize: entry.partySize, startAt: reservation.startAt, timezone: s.timezone, reference, manageUrl }, reservationId: reservationRef.id, waitlistId: ref.id, sendAt: now });
      }
      return { reference, status: reservation.status, manageToken, startAt: reservation.startAt, deposit };
    });
  }
  throw new HttpsError4("not-found", "No se encuentra la oferta.");
}));

// src/messages/lifecycle.ts
var mensajesReservaActualizada = onDocumentUpdated({ ...options, document: "restaurants/{rid}/locations/{lid}/reservations/{reservationId}" }, async (event) => {
  if (!event.data) return;
  const before = parse(ReservationSchema, event.data.before.data()), after = parse(ReservationSchema, event.data.after.data());
  if (before.status === after.status && before.startAt === after.startAt) return;
  const { rid, lid, reservationId } = event.params;
  const path = `restaurants/${rid}/locations/${lid}`;
  await db.runTransaction(async (tx) => {
    const [currentDoc, settingsDoc, pending] = await Promise.all([tx.get(event.data.after.ref), tx.get(db.doc(`${path}/settings/reservations`)), tx.get(db.collection(`restaurants/${rid}/messages`).where("reservationId", "==", reservationId))]);
    if (!currentDoc.exists) return;
    const current = parse(ReservationSchema, currentDoc.data());
    const settings2 = settingsDoc.exists ? parse(ReservationSettingsSchema, settingsDoc.data()) : null;
    if (before.status !== "finished" && after.status === "finished" && current.status === "finished" && settings2?.reviews.enabled && settings2.reviews.googleReviewUrl) {
      const sendAt = instanteDeHoraLocal(sumarDias(horaLocal(current.startAt, settings2.timezone).fecha, 1), 720, settings2.timezone);
      for (const channel of ["email", "whatsapp"]) {
        const to = channel === "email" ? current.email : current.phone;
        const key = `review_${reservationId}_${channel}`;
        if (to && !pending.docs.some((d) => d.id === key)) queue(tx, rid, { channel, to, template: "review_request", language: current.language, data: { guestName: current.guestName, googleReviewUrl: settings2.reviews.googleReviewUrl }, reservationId, waitlistId: null, sendAt }, key);
      }
    }
  });
  if (["cancelled", "no_show"].includes(after.status) && before.status !== after.status) await offerWaitlist(rid, lid);
});
async function expireOffers() {
  const entries = await db.collectionGroup("waitlist").where("status", "==", "offered").get();
  const locations = /* @__PURE__ */ new Set();
  for (const doc of entries.docs) await db.runTransaction(async (tx) => {
    const incrementLock = await reservationLock(tx, doc.ref.parent.parent.path);
    const entry = (await tx.get(doc.ref)).data();
    if (entry?.status === "offered" && entry.offer?.expiresAt.toMillis() <= Date.now()) {
      incrementLock();
      tx.update(doc.ref, { status: "expired", updatedAt: Timestamp3.now() });
      locations.add(doc.ref.parent.parent.path);
    }
  });
  for (const path of locations) {
    const parts2 = path.split("/");
    await offerWaitlist(parts2[1], parts2[3]);
  }
}

// src/providers/send.ts
async function sendMessage(message, key) {
  const rendered = renderMessage(message);
  const email = message.channel === "email";
  const configured = email ? process.env.RESEND_API_KEY && process.env.EMAIL_FROM : process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!configured) return { status: process.env.FUNCTIONS_EMULATOR === "true" ? "captured" : "not_configured", rendered: { subject: rendered.subject, body: rendered.body }, provider: null, providerMessageId: null };
  const buttons = rendered.buttons.map((b) => ({ type: "reply", reply: { id: `${key}:${b.id}`, title: b.title } }));
  const payload2 = email ? { from: process.env.EMAIL_FROM, to: [message.to], subject: rendered.subject, text: rendered.body } : { messaging_product: "whatsapp", to: message.to.slice(1), ...buttons.length ? { type: "interactive", interactive: { type: "button", body: { text: rendered.body }, action: { buttons } } } : { type: "text", text: { body: rendered.body } } };
  const response = await fetch(email ? "https://api.resend.com/emails" : `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, { method: "POST", headers: { Authorization: `Bearer ${email ? process.env.RESEND_API_KEY : process.env.WHATSAPP_TOKEN}`, "Content-Type": "application/json", ...email ? { "Idempotency-Key": key } : {} }, body: JSON.stringify(payload2), signal: AbortSignal.timeout(15e3) });
  if (!response.ok) throw new Error(`El proveedor ha rechazado el env\xEDo (${response.status}).`);
  const result = await response.json();
  const providerMessageId = email ? result.id : result.messages?.[0]?.id;
  if (!providerMessageId) throw new Error("El proveedor no ha devuelto un identificador de env\xEDo.");
  return { status: "sent", rendered: { subject: rendered.subject, body: rendered.body }, provider: email ? "resend" : "whatsapp_cloud", providerMessageId };
}

// src/messages/process.ts
async function processMessage(ref, now = Date.now()) {
  const claim = randomUUID();
  const message = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const m = parse(MessageSchema, snap.data());
    if (m.status !== "queued" || m.sendAt > now || (snap.get("leaseUntil")?.toMillis() ?? 0) > now) return null;
    tx.update(ref, { leaseUntil: Timestamp4.fromMillis(now + 6e4), claim, attempts: m.attempts + 1 });
    return m;
  });
  if (!message) return null;
  let result;
  try {
    result = { ...await sendMessage(message, ref.path), lastError: null };
  } catch (e) {
    result = { status: "failed", lastError: e instanceof Error ? e.message.slice(0, 1e3) : "No se ha podido enviar el mensaje." };
  }
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (snap.get("claim") === claim && snap.get("status") === "queued") tx.update(ref, { ...result, leaseUntil: FieldValue2.delete(), claim: FieldValue2.delete(), updatedAt: FieldValue2.serverTimestamp() });
  });
  return result.status;
}
async function processPending(rid, limit = 100) {
  await expireOffers();
  const query = rid ? db.collection(`restaurants/${rid}/messages`) : db.collectionGroup("messages");
  const docs = await query.where("status", "==", "queued").get();
  const counts = { processed: 0, sent: 0, captured: 0, notConfigured: 0, failed: 0 };
  for (const doc of docs.docs) {
    if (counts.processed >= limit) break;
    const status = await processMessage(doc.ref);
    if (status) {
      counts.processed++;
      if (status === "not_configured") counts.notConfigured++;
      else counts[status]++;
    }
  }
  return counts;
}
var procesarMensajesPendientes = onCall6(options, (request) => safe(async () => {
  const uid = uidOf(request);
  const data = parse(CALLABLE_SCHEMAS[CALLABLES.procesarMensajesPendientes].input, request.data);
  if (request.auth?.token.logiqd !== true) {
    if (!data.restaurantId) throw new HttpsError5("permission-denied", "Selecciona un restaurante.");
    const actor = await db.runTransaction((tx) => membership(tx, data.restaurantId, uid));
    if (!actor.active || !can(actor.role, "mensajes.ver")) throw new HttpsError5("permission-denied", "No tienes permiso para ver mensajes.");
  }
  return processPending(data.restaurantId, data.limit);
}));
var mensajeCreado = onDocumentCreated({ ...options, document: "restaurants/{rid}/messages/{mid}" }, async (event) => {
  if (event.data) await processMessage(event.data.ref);
});
var mensajesProgramados = onSchedule({ ...options, schedule: "every 5 minutes" }, async () => {
  await processPending();
});

// src/reservations.ts
import { randomBytes as randomBytes3, timingSafeEqual } from "crypto";
import { FieldValue as FieldValue4, Timestamp as Timestamp6 } from "firebase-admin/firestore";
import { onCall as onCall7, HttpsError as HttpsError7 } from "firebase-functions/v2/https";

// src/fase2/sessions.ts
var sessions_exports = {};
__export(sessions_exports, {
  abrirMesa: () => abrirMesa,
  billTask: () => billTask,
  cambiarEstadoMesa: () => cambiarEstadoMesa,
  checkReservationPosLock: () => checkReservationPosLock,
  editarMesa: () => editarMesa,
  juntarMesas: () => juntarMesas,
  moverMesa: () => moverMesa,
  openReservation: () => openReservation,
  prepareFinishReservation: () => prepareFinishReservation,
  prepareSeatReservation: () => prepareSeatReservation,
  separarMesas: () => separarMesas,
  validateTables: () => validateTables
});

// src/fase2/context.ts
import { FieldPath, FieldValue as FieldValue3, Timestamp as Timestamp5 } from "firebase-admin/firestore";
import { HttpsError as HttpsError6 } from "firebase-functions/v2/https";
var fail = (message) => {
  throw new HttpsError6("failed-precondition", message);
};
var denied = () => {
  throw new HttpsError6("permission-denied", "No tienes permiso para esta operaci\xF3n en este local.");
};
var schemas = {
  menuCategories: MenuCategorySchema,
  menuItems: MenuItemSchema,
  dailyMenus: DailyMenuSchema,
  stations: StationSchema,
  tableSessions: TableSessionSchema,
  orders: OrderSchema,
  orderLines: OrderLineSchema,
  floorTasks: FloorTaskSchema,
  takeaways: TakeawaySchema,
  tables: TableSchema,
  reservations: ReservationSchema,
  waitlist: WaitlistEntrySchema
};
async function resolveRestaurant(tx, slug) {
  const rows = await tx.get(db.collection("restaurants").where("slug", "==", slug).limit(1));
  if (rows.empty) throw new HttpsError6("not-found", "No se encuentra el restaurante.");
  return rows.docs[0].id;
}
async function context(tx, rid, lid, request, name) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection("locations").doc(lid);
  const [r, l, lock2, floor, reservations] = await Promise.all([
    tx.get(root),
    tx.get(local),
    tx.get(local.collection("reservationLocks").doc("current")),
    tx.get(local.collection("settings").doc("floor")),
    tx.get(local.collection("settings").doc("reservations"))
  ]);
  if (!r.exists || !l.exists) throw new HttpsError6("not-found", "No se encuentra el restaurante o el local.");
  const restaurant = r.data(), location = l.data();
  const actor = request ? await membership(tx, rid, uidOf(request)) : null;
  if (actor && (!actor.active || actor.locationIds.length > 0 && !actor.locationIds.includes(lid))) denied();
  if (name && actor) {
    const access = FASE2_ACCESS[name];
    if (access.permission !== "public" && access.permission !== "per_line" && !can(actor.role, access.permission)) denied();
    if (!hasModule(restaurant, access.module)) fail("El m\xF3dulo necesario est\xE1 desactivado.");
    if ((actor.role === "kitchen" || actor.role === "bar") && !hasModule(restaurant, "kitchen")) denied();
  }
  const rows = {};
  await Promise.all(Object.entries(schemas).map(async ([name2, schema]) => {
    const snap = await tx.get(local.collection(name2));
    const values = new Map(snap.docs.map((d) => [d.id, { ...schema.parse(d.data()), id: d.id }]));
    Object.assign(rows, { [name2]: values });
  }));
  const privateNames2 = ["tableTokens", "reservationSessions", "taskKeys", "spendContributions", "serviceLocks"];
  const privateRows = {};
  await Promise.all(privateNames2.map(async (name2) => {
    const query = name2 === "serviceLocks" ? local.collection(name2).where(FieldPath.documentId(), "!=", "publication") : local.collection(name2);
    privateRows[name2] = new Map((await tx.get(query)).docs.map((d) => [d.id, d.data()]));
  }));
  const [customersSnap, membersSnap, refsSnap, messagesSnap] = await Promise.all([
    tx.get(root.collection("customers")),
    tx.get(root.collection("members")),
    tx.get(root.collection("takeawayReferences")),
    tx.get(root.collection("messages"))
  ]);
  const customers = new Map(customersSnap.docs.map((d) => [d.id, d.data()]));
  const members = new Map(membersSnap.docs.map((d) => [d.id, MemberSchema.parse(d.data())]));
  const takeawayReferences = new Map(refsSnap.docs.map((d) => [d.id, d.data()]));
  const posBills = new Map((await tx.get(local.collection("bills"))).docs.map((d) => [d.id, BillSchema.parse(d.data())]));
  const posTargets = new Map((await tx.get(local.collection("billTargets"))).docs.map((d) => [d.id, d.get("billId")]));
  const writes = /* @__PURE__ */ new Map();
  const now = Date.now(), uid = actor?.uid ?? null;
  const changeId = root.collection("activity").doc().id;
  function stage(path, data, fresh = false) {
    const previous = writes.get(path);
    writes.set(path, { data: { ...previous?.data, ...data }, fresh: previous?.fresh ?? fresh });
  }
  function put(name2, value, fresh = false) {
    const row = value;
    guardPosWrite(name2, row.id, value);
    rows[name2].set(row.id, value);
    const { id: _id, ...data } = row;
    stage(`${local.path}/${name2}/${row.id}`, data, fresh);
    if (name2 === "reservations" && ["seated", "finished"].includes(data.status)) {
      for (const message of messagesSnap.docs) if (message.get("reservationId") === row.id && message.get("status") === "queued") stage(message.ref.path, { status: "cancelled" });
    }
  }
  function secret(name2, id2, data) {
    const fresh = !privateRows[name2].has(id2);
    privateRows[name2].set(id2, data);
    stage(`${local.path}/${name2}/${id2}`, data, fresh);
  }
  function guardPosWrite(name2, id2, next) {
    const billFor = (kind, targetId) => posBills.get(posTargets.get(sha256Hex(JSON.stringify([kind, targetId]))) ?? "");
    const frozen = (kind, targetId) => {
      const bill = billFor(kind, targetId);
      return !!bill && bill.status !== "open" && bill.status !== "cancelled";
    };
    if (name2 === "orderLines") {
      const old = rows.orderLines.get(id2);
      const targets = [old, next].filter(Boolean);
      const changed = !old || ["sessionId", "takeawayId", "totalCents", "taxRate", "quantity", "parentLineId"].some((k) => old[k] !== next[k]) || old.status === "cancelled" !== (next.status === "cancelled");
      if (changed && targets.some((l2) => l2.sessionId ? frozen("session", l2.sessionId) : l2.takeawayId && frozen("takeaway", l2.takeawayId))) fail("La cuenta est\xE1 bloqueada para cobrar. No se puede cambiar el consumo ni su destino.");
    }
    if (name2 === "tableSessions") {
      const old = rows.tableSessions.get(id2);
      if (old && frozen("session", id2) && (JSON.stringify(old.tableIds) !== JSON.stringify(next.tableIds) || old.label !== next.label || old.status === "closed" && next.status !== "closed" || next.status === "merged" || next.status === "cancelled")) fail("La cuenta est\xE1 bloqueada o saldada. No se puede mover, juntar, separar ni reabrir la mesa.");
      if (next.status === "closed" && old?.status !== "closed" && hasModule(restaurant, "pos")) {
        const lines = [...rows.orderLines.values()].filter((l2) => l2.sessionId === id2 && l2.status !== "cancelled");
        if (lines.some((l2) => l2.totalCents > 0 || l2.status === "pending") && billFor("session", id2)?.status !== "settled") fail("Salda la cuenta antes de cerrar la mesa.");
      }
    }
    if (name2 === "takeaways") {
      const old = rows.takeaways.get(id2);
      if (old && frozen("takeaway", id2) && (next.status === "cancelled" || old.status === "picked_up" && next.status !== old.status)) fail("La cuenta est\xE1 bloqueada o saldada. No se puede cancelar ni reabrir el pedido.");
      if (next.status === "picked_up" && old?.status !== "picked_up" && hasModule(restaurant, "pos")) {
        const lines = [...rows.orderLines.values()].filter((l2) => l2.takeawayId === id2 && l2.status !== "cancelled");
        if (lines.some((l2) => l2.totalCents > 0 || l2.status === "pending") && billFor("takeaway", id2)?.status !== "settled") fail("Salda la cuenta antes de recoger el pedido para llevar.");
      }
    }
  }
  function flush(action, summary) {
    if (!writes.size) return;
    const conversions = {
      tableSessions: tableSessionForWrite,
      orders: orderForWrite,
      orderLines: orderLineForWrite,
      floorTasks: floorTaskForWrite,
      takeaways: takeawayForWrite,
      reservations: reservationForWrite
    };
    for (const [path, { data, fresh }] of writes) {
      const collection = path.split("/").at(-2);
      const convert = conversions[collection];
      const value = convert ? convert(data, Timestamp5.fromMillis) : data;
      tx.set(db.doc(path), { ...value, updatedBy: uid, changeId, updatedAt: FieldValue3.serverTimestamp(), ...fresh ? { createdAt: FieldValue3.serverTimestamp() } : {} }, { merge: true });
    }
    tx.set(lock2.ref, { revision: FieldValue3.increment(1) }, { merge: true });
    if (action) tx.create(root.collection("activity").doc(changeId), { action, summary, actorUid: uid, actorName: actor?.displayName ?? null, entity: { type: "location", id: lid }, createdAt: FieldValue3.serverTimestamp(), updatedAt: FieldValue3.serverTimestamp() });
  }
  return {
    tx,
    rid,
    lid,
    root,
    local,
    restaurant,
    location,
    actor,
    uid,
    now,
    posBills,
    posTargets,
    rows,
    privateRows,
    customers,
    members,
    takeawayReferences,
    writes,
    stage,
    put,
    secret,
    flush,
    floorExists: floor.exists,
    settings: floor.exists ? FloorSettingsSchema.parse(floor.data()) : defaultFloorSettings(),
    reservationSettings: reservations.exists ? ReservationSettingsSchema.parse(reservations.data()) : defaultReservationSettings(restaurant.timezone)
  };
}
function requireFloor(c) {
  if (!hasModule(c.restaurant, "floor")) fail("El m\xF3dulo de sala est\xE1 desactivado.");
}
function get(c, collection, id2) {
  const value = c.rows[collection].get(id2);
  if (!value) throw new HttpsError6("not-found", "No se encuentra el documento en este local.");
  return value;
}
function permission(c, p) {
  return !!c.actor && can(c.actor.role, p);
}
function newId(c, collection) {
  return c.local.collection(collection).doc().id;
}
function checkLine(c, line, status, reason = null) {
  if (line.kind === "menu") fail("El estado del men\xFA lo determinan sus platos.");
  if (line.status === status) return;
  if (line.status === "pending") fail("Decide primero el pedido pendiente.");
  const allowed = (p) => permission(c, p) && (!["cocina.preparar", "barra.preparar"].includes(p) || hasModule(c.restaurant, "kitchen"));
  const result = checkLineTransition(line, status, allowed, reason);
  if (!result.ok) {
    if (!lineTransitionPermissions(line.status, status, line.stationKind).some(allowed)) denied();
    fail(result.reason);
  }
}
function publicMenu(c) {
  return buildPublicMenu({
    restaurantId: c.rid,
    locationId: c.lid,
    restaurantName: c.restaurant.name,
    locationName: c.location.name,
    brandColor: c.restaurant.brandColor,
    timezone: c.reservationSettings.timezone,
    settings: c.settings,
    categories: Object.fromEntries(c.rows.menuCategories),
    items: Object.fromEntries(c.rows.menuItems),
    dailyMenus: Object.fromEntries(c.rows.dailyMenus),
    floorModule: hasModule(c.restaurant, "floor")
  });
}

// src/fase2/service.ts
var destinationLines = (c, sessionId, takeawayId) => [...c.rows.orderLines.values()].filter((l) => sessionId ? l.sessionId === sessionId : l.takeawayId === takeawayId);
function destination(c, sessionId, takeawayId) {
  if (sessionId) {
    const s = get(c, "tableSessions", sessionId);
    if (!sessionIsOpen(s.status)) fail("La mesa ya no est\xE1 abierta. Vuelve a consultarla.");
    return { label: s.label, tableIds: s.tableIds };
  }
  const t = get(c, "takeaways", takeawayId);
  if (!["pending", "accepted", "ready"].includes(t.status)) fail("El pedido para llevar ya est\xE1 cerrado.");
  return { label: takeawayLabel(t.guestName, horaLocal(t.pickupAt, c.reservationSettings.timezone).hora), tableIds: [] };
}
function customer(c, name, phone, email = null, language = "es") {
  const id2 = customerIdFor(c.rid, phone);
  if (!c.customers.has(id2)) {
    const value = { name, phone, email, language, visits: 0, noShows: 0, cancellations: 0, lastVisitAt: null, notes: "", allergies: "", tags: [], spentCents: 0 };
    c.customers.set(id2, value);
    c.stage(`${c.root.path}/customers/${id2}`, value, true);
  }
  return id2;
}
function lineStatus(c, line, status, reason = null) {
  if (line.status !== status) c.put("orderLines", applyLineStatus(line, status, c.now, c.uid, reason));
}
function sessionStatus(c, s, status, reason = null) {
  if (s.status === status) return;
  c.put("tableSessions", {
    ...s,
    status,
    billRequestedAt: status === "bill_requested" ? c.now : null,
    closedAt: status === "closed" || status === "cancelled" || status === "merged" ? c.now : null,
    closedBy: status === "closed" || status === "cancelled" || status === "merged" ? c.uid : null,
    history: [...s.history, { from: s.status, to: status, at: c.now, by: c.uid, reason }]
  });
}
function takeawayStatus(c, t, status, reason = null) {
  if (t.status === status) return;
  c.put("takeaways", {
    ...t,
    status,
    readyAt: status === "ready" ? c.now : status === "picked_up" ? t.readyAt : null,
    pickedUpAt: status === "picked_up" ? c.now : null,
    cancelReason: status === "cancelled" ? reason : t.cancelReason,
    history: [...t.history, { from: t.status, to: status, at: c.now, by: c.uid, reason }]
  });
}
function closeTask(c, task2, status = "done") {
  if (taskIsActive(task2.status)) c.put("floorTasks", { ...task2, status, doneAt: c.now, doneBy: c.uid });
}
function task(c, input) {
  const dedupeKey = taskDedupeKey(input.type, { ...input, tableId: input.tableId });
  const key = dedupeKey ? sha256Hex(dedupeKey) : null;
  const index = key ? c.privateRows.taskKeys.get(key) : void 0;
  const old = index ? c.rows.floorTasks.get(index.taskId) : void 0;
  if (old && old.dedupeKey === dedupeKey && taskIsActive(old.status)) {
    const next = { ...old, tableIds: input.tableIds, label: input.label, count: old.count + 1, lineIds: [.../* @__PURE__ */ new Set([...old.lineIds, ...input.lineIds ?? []])] };
    c.put("floorTasks", next);
    return next;
  }
  const id2 = newId(c, "floorTasks");
  const value = {
    id: id2,
    type: input.type,
    status: "open",
    sessionId: input.sessionId,
    takeawayId: input.takeawayId,
    tableIds: input.tableIds,
    label: input.label,
    orderId: input.orderId ?? null,
    stationId: input.stationId ?? null,
    lineIds: input.lineIds ?? [],
    note: input.note ?? "",
    dedupeKey,
    count: 1,
    openedAt: c.now,
    dueAt: taskDueAt(input.type, c.now, c.settings.targets),
    createdBy: c.uid,
    claimedBy: null,
    claimedByName: null,
    claimedAt: null,
    doneAt: null,
    doneBy: null
  };
  c.put("floorTasks", value, true);
  if (key) c.secret("taskKeys", key, { ...index, taskId: id2 });
  return value;
}
function reconcile(c) {
  for (const parent of c.rows.orderLines.values()) if (parent.kind === "menu") {
    const children = [...c.rows.orderLines.values()].filter((l) => l.parentLineId === parent.id);
    const status = menuLineStatus(children);
    if (parent.status !== status) lineStatus(c, parent, status);
  }
  for (const s of c.rows.tableSessions.values()) {
    const totals = sessionTotals(destinationLines(c, s.id, null));
    if (s.totalCents !== totals.totalCents || s.lineCount !== totals.lineCount || s.unservedCount !== totals.unservedCount) c.put("tableSessions", { ...s, ...totals });
  }
  for (const t of c.rows.takeaways.values()) {
    const lines = destinationLines(c, null, t.id);
    const totalCents = sessionTotals(lines).totalCents;
    if (t.totalCents !== totalCents) c.put("takeaways", { ...t, totalCents });
    let current = get(c, "takeaways", t.id);
    if (lines.length && !lines.some((l) => l.kind !== "menu" && l.status !== "cancelled") && ["accepted", "ready", "pending"].includes(current.status)) {
      takeawayStatus(c, current, "cancelled", "Todos los platos est\xE1n anulados.");
    } else {
      const status = takeawayStatusFromLines(current.status, lines);
      if (status !== current.status) takeawayStatus(c, current, status);
    }
    current = get(c, "takeaways", t.id);
    if (current.status === "picked_up" || current.status === "cancelled") {
      for (const task2 of c.rows.floorTasks.values()) if (task2.takeawayId === t.id) closeTask(c, task2, "cancelled");
    }
  }
  reconcilePickups(c);
  reconcileSpend(c);
}
function reconcilePickups(c) {
  const stations = Object.fromEntries(c.rows.stations);
  const destinations = [
    ...[...c.rows.tableSessions.values()].filter((s) => sessionIsOpen(s.status)).map((s) => ({ sessionId: s.id, takeawayId: null, tableIds: s.tableIds, label: s.label })),
    ...[...c.rows.takeaways.values()].filter((t) => ["accepted", "ready"].includes(t.status)).map((t) => ({ sessionId: null, takeawayId: t.id, tableIds: [], label: takeawayLabel(t.guestName, horaLocal(t.pickupAt, c.reservationSettings.timezone).hora) }))
  ];
  const wanted = /* @__PURE__ */ new Set();
  for (const dest of destinations) {
    const lines = destinationLines(c, dest.sessionId, dest.takeawayId);
    for (const [stationId, lineIds] of Object.entries(readyForPickup(lines, stations))) {
      const dedupeKey = taskDedupeKey("pickup", { ...dest, stationId });
      const key = sha256Hex(dedupeKey), index = c.privateRows.taskKeys.get(key);
      const existing = index ? c.rows.floorTasks.get(index.taskId) : void 0;
      const readyVersions = Object.fromEntries(lineIds.map((id2) => [id2, get(c, "orderLines", id2).readyAt]));
      wanted.add(dedupeKey);
      if (existing && existing.dedupeKey === dedupeKey && taskIsActive(existing.status)) {
        if (JSON.stringify(existing.lineIds) !== JSON.stringify(lineIds) || existing.label !== dest.label) c.put("floorTasks", { ...existing, ...dest, lineIds });
      } else if (lineIds.some((id2) => index?.readyVersions?.[id2] !== readyVersions[id2])) {
        task(c, { type: "pickup", ...dest, stationId, lineIds });
      }
      const current = c.privateRows.taskKeys.get(key);
      if (current && JSON.stringify(current.readyVersions) !== JSON.stringify(readyVersions)) c.secret("taskKeys", key, { ...current, readyVersions });
    }
  }
  for (const t of c.rows.floorTasks.values()) if (t.type === "pickup" && t.dedupeKey && !wanted.has(t.dedupeKey)) closeTask(c, t);
}
function reconcileSpend(c) {
  const targets = [
    ...[...c.rows.tableSessions.values()].map((s) => ({ kind: "session", id: s.id, customerId: s.customerId, amountCents: s.status === "closed" ? s.totalCents : 0 })),
    ...[...c.rows.takeaways.values()].map((t) => ({ kind: "takeaway", id: t.id, customerId: t.customerId, amountCents: t.status === "picked_up" ? t.totalCents : 0 }))
  ];
  const deltas = /* @__PURE__ */ new Map();
  for (const target of targets) {
    const key = sha256Hex(JSON.stringify([target.kind, target.id]));
    const old = c.privateRows.spendContributions.get(key);
    const nextAmount = target.customerId ? target.amountCents : 0;
    if ((old?.customerId ?? null) === target.customerId && (old?.amountCents ?? 0) === nextAmount) continue;
    if (old?.customerId) deltas.set(old.customerId, (deltas.get(old.customerId) ?? 0) - old.amountCents);
    if (target.customerId) deltas.set(target.customerId, (deltas.get(target.customerId) ?? 0) + nextAmount);
    c.secret("spendContributions", key, { customerId: target.customerId, amountCents: nextAmount });
  }
  for (const [id2, delta] of deltas) {
    if (!delta) continue;
    const old = c.customers.get(id2);
    if (!old) fail("No se encuentra el cliente del consumo.");
    const spentCents = Number(old.spentCents ?? 0) + delta;
    if (!Number.isSafeInteger(spentCents) || spentCents < 0) fail("El gasto del cliente est\xE1 fuera de rango.");
    c.customers.set(id2, { ...old, spentCents });
    c.stage(`${c.root.path}/customers/${id2}`, { spentCents });
  }
}

// src/fase2/sessions.ts
var tables = (c) => Object.fromEntries(c.rows.tables);
var occupancy = (c) => Object.fromEntries([...c.rows.tableSessions.values()].filter((s) => sessionIsOpen(s.status)).flatMap((s) => s.tableIds.map((t) => [t, s.id])));
function plan(value) {
  if (!value.ok) fail("Las mesas elegidas no est\xE1n disponibles. Revisa la ocupaci\xF3n y la selecci\xF3n.");
  return value;
}
function validateTables(c, tableIds, guests, excludeSessions = [], excludeReservations = []) {
  if (tableIds.length < 1 || tableIds.length > 8 || new Set(tableIds).size !== tableIds.length) fail("Elige entre una y ocho mesas distintas.");
  const selected = tableIds.map((id2) => get(c, "tables", id2));
  if (selected.some((t) => !t.enabled)) fail("Alguna mesa est\xE1 desactivada.");
  const config = settingsToConfiguracion(c.reservationSettings);
  const seats = selected.reduce((n, t) => n + t.seats, 0) - (selected.length - 1) * config.plazasPerdidasPorUnion;
  if (guests < 1 || guests > 200 || guests > seats) fail("Las mesas no admiten ese n\xFAmero de comensales.");
  const interval = { inicio: c.now, fin: c.now + duracionParaGrupo(config, guests) * 6e4 };
  const reservations = floorOccupancy(c).filter((r) => !excludeSessions.some((id2) => r.id === `session:${id2}`) && !excludeReservations.includes(r.id));
  const occupied = construirOcupacion(reservations, c.now);
  if (tableIds.some((id2) => choquesDeMesa(occupied, id2, interval, config.margenMinutos).length)) fail("Estas mesas coinciden con otra sesi\xF3n o reserva.");
  const motorTables = [...c.rows.tables.values()].map((t) => tableToMesa(t.id, t));
  const combinations = combinacionesDeMesas(motorTables, config.maxMesasUnidas, config.plazasPerdidasPorUnion);
  const requests = solicitudesSinMesa(interval, occupied, config.margenMinutos, (n) => opcionesParaGrupo(combinations, motorTables, n));
  const fitting = encajarSolicitudes([{ id: "opening", intervalo: interval, comensales: guests, opciones: [{ mesaIds: tableIds, plazas: seats, areaIds: [...new Set(selected.map((t) => t.areaId))] }] }, ...requests], occupied, config.margenMinutos);
  if (fitting.tipo !== "encaja") fail("No queda capacidad para las reservas previstas.");
}
function waiter(c, uid) {
  const id2 = uid === void 0 ? c.uid : uid;
  if (!id2) return { waiterUid: null, waiterName: null };
  const member = c.members.get(id2);
  if (!member?.active || !can(member.role, "sala.gestionar") || member.locationIds.length && !member.locationIds.includes(c.lid)) fail("El responsable no puede trabajar en este local.");
  return { waiterUid: id2, waiterName: member.displayName };
}
function freshSession(c, fields, responsible, notes = "") {
  const id2 = newId(c, "tableSessions");
  const session = {
    ...fields,
    id: id2,
    ...waiter(c, responsible),
    status: "open",
    label: sessionLabel(fields.tableIds, tables(c)),
    notes,
    openedAt: c.now,
    openedBy: c.uid,
    closedAt: null,
    closedBy: null,
    billRequestedAt: null,
    mergedInto: null,
    totalCents: 0,
    lineCount: 0,
    unservedCount: 0,
    history: []
  };
  c.put("tableSessions", session, true);
  return session;
}
function openReservation(c, reservationId, responsible, notes = "", writeReservation = true) {
  if (!permission(c, "reservas.gestionar")) denied();
  if (!hasModule(c.restaurant, "reservations")) fail("El m\xF3dulo de reservas est\xE1 desactivado.");
  const r = get(c, "reservations", reservationId);
  const index = c.privateRows.reservationSessions.get(reservationId);
  if (index) {
    const s2 = get(c, "tableSessions", index.sessionId);
    if (!sessionIsOpen(s2.status) || r.status !== "seated") fail("Esta reserva ya tiene una sesi\xF3n cerrada o absorbida.");
    return { sessionId: s2.id, label: s2.label, joinable: tablesAreJoinable(s2.tableIds, tables(c)), reservationSeated: false };
  }
  if (!r.tableIds.length) fail("Asigna mesas a la reserva antes de sentarla.");
  if (r.status !== "seated") {
    const change2 = applyStatusChange(r, "seated", { nowMs: c.now, by: c.uid });
    if (!change2.ok) fail(change2.reason);
    if (writeReservation && change2.ok) c.put("reservations", change2.reservation);
  }
  plan(planOpen(r.tableIds, tables(c), occupancy(c)));
  validateTables(c, r.tableIds, r.partySize, [], [r.id]);
  customer(c, r.guestName, r.phone, r.email, r.language);
  const s = freshSession(c, sessionFromReservation(r, reservationId), responsible, notes);
  c.secret("reservationSessions", reservationId, { sessionId: s.id });
  return { sessionId: s.id, label: s.label, joinable: tablesAreJoinable(r.tableIds, tables(c)), reservationSeated: r.status !== "seated" };
}
function abrirMesa(c, d) {
  if (d.reservationId) {
    const r = get(c, "reservations", d.reservationId);
    if (r.tableIds.length !== d.tableIds.length || !r.tableIds.every((id2) => d.tableIds.includes(id2))) fail("Las mesas deben coincidir con las asignadas a la reserva.");
    return openReservation(c, r.id, d.waiterUid, d.notes);
  }
  const p = plan(planOpen(d.tableIds, tables(c), occupancy(c)));
  validateTables(c, d.tableIds, d.guests);
  const customerId = d.guest ? customer(c, d.guest.name, d.guest.phone) : null;
  const s = freshSession(c, { tableIds: d.tableIds, guests: d.guests, reservationId: null, customerId, guestName: d.guest?.name ?? null }, d.waiterUid, d.notes);
  return { sessionId: s.id, label: s.label, joinable: p.joinable, reservationSeated: false };
}
function representedSources(c, id2) {
  return [...c.rows.tableSessions.values()].filter((s) => s.mergedInto === id2).flatMap((s) => [s, ...representedSources(c, s.id)]);
}
function finishReservations(c, s) {
  const sessions = [s, ...representedSources(c, s.id)];
  const seated = sessions.flatMap((s2) => s2.reservationId ? [get(c, "reservations", s2.reservationId)] : []).filter((r) => r.status === "seated");
  if (seated.length && (!permission(c, "reservas.gestionar") || !hasModule(c.restaurant, "reservations"))) denied();
  for (const r of seated) {
    const change2 = applyStatusChange(r, "finished", { nowMs: c.now, by: c.uid });
    if (change2.ok) c.put("reservations", change2.reservation);
  }
}
function cambiarEstadoMesa(c, d) {
  const s = get(c, "tableSessions", d.sessionId);
  if (s.status === d.status) return { ok: true, status: s.status, totalCents: s.totalCents };
  if (!canSessionTransition(s.status, d.status)) fail("La mesa no admite ese cambio de estado.");
  const lines = destinationLines(c, s.id, null);
  if (d.status === "closed") {
    if (checkCloseSession(lines).length) fail("Sirve o anula todos los platos y decide los pedidos pendientes antes de cerrar.");
    finishReservations(c, s);
  }
  if (d.status === "cancelled" && checkCancelSession(lines).length) fail("No se puede anular una mesa con pedidos vivos.");
  if (s.status === "closed") {
    plan(planOpen(s.tableIds, tables(c), occupancy(c)));
    validateTables(c, s.tableIds, s.guests, [s.id]);
    c.put("tableSessions", { ...s, openedAt: c.now });
  }
  sessionStatus(c, get(c, "tableSessions", s.id), d.status, d.reason ?? null);
  if (d.status === "closed" || d.status === "cancelled" || s.status === "bill_requested" && d.status === "open") {
    for (const t of c.rows.floorTasks.values()) if (t.sessionId === s.id && (d.status !== "open" || t.type === "bill_request")) closeTask(c, t, "cancelled");
  }
  if (d.status === "bill_requested") {
    billTask(c, get(c, "tableSessions", s.id));
  }
  return { ok: true, status: d.status, totalCents: sessionTotals(lines).totalCents };
}
function billTask(c, s) {
  return task(c, { type: "bill_request", sessionId: s.id, takeawayId: null, tableIds: s.tableIds, label: s.label });
}
function editarMesa(c, d) {
  const s = get(c, "tableSessions", d.sessionId);
  if (!sessionIsOpen(s.status)) fail("La mesa ya est\xE1 cerrada.");
  if (d.guests !== void 0) validateTables(c, s.tableIds, d.guests, [s.id], s.reservationId ? [s.reservationId] : []);
  c.put("tableSessions", { ...s, guests: d.guests ?? s.guests, notes: d.notes ?? s.notes, ...d.waiterUid !== void 0 ? waiter(c, d.waiterUid) : {} });
  return { ok: true };
}
function relocate(c, sessionId, targetId, label, tableIds, lineIds) {
  for (const l of c.rows.orderLines.values()) if (l.sessionId === sessionId && (!lineIds || lineIds.includes(l.id))) c.put("orderLines", { ...l, sessionId: targetId, label });
  for (const t of c.rows.floorTasks.values()) if (t.sessionId === sessionId && taskIsActive(t.status)) {
    if (lineIds && t.lineIds.length && !t.lineIds.some((id2) => lineIds.includes(id2))) continue;
    if (lineIds && !t.lineIds.length) {
      c.put("floorTasks", { ...t, tableIds: get(c, "tableSessions", sessionId).tableIds, label: get(c, "tableSessions", sessionId).label });
      continue;
    }
    const key = taskDedupeKey(t.type, { sessionId: targetId, orderId: t.orderId, stationId: t.stationId });
    const remaining = lineIds ? t.lineIds.filter((id2) => !lineIds.includes(id2)) : [];
    if (remaining.length) {
      const source2 = get(c, "tableSessions", sessionId);
      c.put("floorTasks", { ...t, lineIds: remaining, tableIds: source2.tableIds, label: source2.label });
      const nextId = newId(c, "floorTasks");
      c.put("floorTasks", { ...t, id: nextId, sessionId: targetId, label, tableIds, lineIds: t.lineIds.filter((id2) => lineIds.includes(id2)), dedupeKey: key }, true);
      if (key) c.secret("taskKeys", sha256Hex(key), { taskId: nextId });
      continue;
    }
    if (t.dedupeKey && t.dedupeKey !== key) {
      const oldKey = sha256Hex(t.dedupeKey);
      if (c.privateRows.taskKeys.get(oldKey)?.taskId === t.id) c.secret("taskKeys", oldKey, { taskId: null, readyVersions: {} });
    }
    const otherIndex = key ? c.privateRows.taskKeys.get(sha256Hex(key)) : void 0;
    const other = otherIndex ? c.rows.floorTasks.get(otherIndex.taskId) : void 0;
    if (other && other.id !== t.id && taskIsActive(other.status)) {
      c.put("floorTasks", { ...other, lineIds: [.../* @__PURE__ */ new Set([...other.lineIds, ...t.lineIds])], count: other.count + t.count, dueAt: Math.min(other.dueAt, t.dueAt) });
      closeTask(c, t, "cancelled");
    } else {
      c.put("floorTasks", { ...t, sessionId: targetId, label, tableIds, dedupeKey: key });
      if (key) c.secret("taskKeys", sha256Hex(key), { taskId: t.id });
    }
  }
}
function moverMesa(c, d) {
  const s = get(c, "tableSessions", d.sessionId);
  const p = plan(planMove(s, d.tableIds, tables(c), occupancy(c)));
  validateTables(c, p.tableIds, s.guests, [s.id], s.reservationId ? [s.reservationId] : []);
  c.put("tableSessions", { ...s, tableIds: p.tableIds, label: p.label });
  relocate(c, s.id, s.id, p.label, p.tableIds);
  return { ok: true, tableIds: p.tableIds, label: p.label };
}
function juntarMesas(c, d) {
  const s = get(c, "tableSessions", d.sessionId);
  const p = plan(planJoin(s, d.tableIds, [...c.rows.tableSessions.values()], tables(c), occupancy(c)));
  const sources = p.mergedSessionIds.map((id2) => get(c, "tableSessions", id2));
  validateTables(c, p.tableIds, p.guests, [s.id, ...p.mergedSessionIds], [s, ...sources].flatMap((s2) => s2.reservationId ? [s2.reservationId] : []));
  c.put("tableSessions", { ...s, tableIds: p.tableIds, label: p.label, guests: p.guests });
  relocate(c, s.id, s.id, p.label, p.tableIds);
  for (const source2 of sources) {
    c.put("tableSessions", { ...source2, mergedInto: s.id });
    sessionStatus(c, get(c, "tableSessions", source2.id), "merged");
    relocate(c, source2.id, s.id, p.label, p.tableIds);
  }
  return p;
}
function separarMesas(c, d) {
  const s = get(c, "tableSessions", d.sessionId), lines = destinationLines(c, s.id, null);
  if (lines.some((l) => l.status === "pending")) fail("Decide los pedidos pendientes antes de separar.");
  const p = plan(planSplit(s, d.tableIds, d.lineIds, lines, tables(c)));
  let newSessionId = null;
  if (p.createsSession) {
    const guests = d.guests;
    if (!guests || guests >= s.guests) fail("Indica los comensales de cada grupo sin dejar ninguno vac\xEDo.");
    validateTables(c, p.splitTableIds, guests, [s.id], s.reservationId ? [s.reservationId] : []);
    validateTables(c, p.keepTableIds, s.guests - guests, [s.id], s.reservationId ? [s.reservationId] : []);
    const next = freshSession(c, { tableIds: p.splitTableIds, guests, customerId: s.customerId, guestName: s.guestName, reservationId: null }, s.waiterUid, s.notes);
    newSessionId = next.id;
    c.put("tableSessions", { ...s, tableIds: p.keepTableIds, label: p.keepLabel, guests: s.guests - guests });
    relocate(c, s.id, next.id, p.splitLabel, p.splitTableIds, p.movedLineIds);
  } else {
    validateTables(c, p.keepTableIds, s.guests, [s.id], s.reservationId ? [s.reservationId] : []);
    c.put("tableSessions", { ...s, tableIds: p.keepTableIds, label: p.keepLabel });
  }
  relocate(c, s.id, s.id, p.keepLabel, p.keepTableIds);
  return { ok: true, newSessionId, keepTableIds: p.keepTableIds, splitTableIds: p.splitTableIds };
}
async function prepareSeatReservation(tx, rid, lid, id2, request) {
  const c = await context(tx, rid, lid, request, "abrirMesa");
  openReservation(c, id2, void 0, "", false);
  return () => {
    reconcile(c);
    c.flush("tableSession.opened", "Mesa abierta al sentar una reserva.");
  };
}
async function prepareFinishReservation(tx, rid, lid, reservationId, request) {
  const c = await context(tx, rid, lid, request, "cambiarEstadoMesa");
  const index = c.privateRows.reservationSessions.get(reservationId);
  if (!index) return null;
  let session = get(c, "tableSessions", index.sessionId);
  const seen = /* @__PURE__ */ new Set();
  while (session.mergedInto) {
    if (seen.has(session.id)) fail("Las sesiones juntadas requieren revisi\xF3n.");
    seen.add(session.id);
    session = get(c, "tableSessions", session.mergedInto);
  }
  if (session.status !== "closed") cambiarEstadoMesa(c, { restaurantId: rid, locationId: lid, sessionId: session.id, status: "closed", reason: null });
  return () => {
    reconcile(c);
    c.flush("tableSession.statusChanged", "Mesa cerrada al terminar la reserva.");
  };
}
async function checkReservationPosLock(tx, rid, lid, reservationId) {
  const c = await context(tx, rid, lid);
  const index = c.privateRows.reservationSessions.get(reservationId);
  if (!index) return;
  const session = get(c, "tableSessions", index.sessionId);
  const billId = c.posTargets.get(sha256Hex(JSON.stringify(["session", session.mergedInto ?? session.id])));
  const bill = billId ? c.posBills.get(billId) : null;
  if (bill && !["open", "cancelled"].includes(bill.status)) fail("La cuenta de esta reserva est\xE1 bloqueada o saldada. No se pueden cambiar sus mesas.");
}

// src/reservations.ts
function callable(name, work) {
  const schemas3 = CALLABLE_SCHEMAS[CALLABLES[name]];
  return onCall7(options, (request) => safe(async () => {
    const data = parse(schemas3.input, request.data);
    return schemas3.output.parse(await work(data, request));
  }));
}
var failure = (message) => {
  throw new HttpsError7("failed-precondition", message);
};
async function restaurantId(tx, slug) {
  const rows = await tx.get(db.collection("restaurants").where("slug", "==", slug).limit(1));
  if (rows.empty) throw new HttpsError7("not-found", "No se encuentra el restaurante.");
  return rows.docs[0].id;
}
async function context2(tx, rid, lid, request, permission2 = "reservas.gestionar", publicBooking = false) {
  const root = db.doc(`restaurants/${rid}`);
  const local = root.collection("locations").doc(lid);
  const restaurant = (await tx.get(root)).data();
  if (!restaurant) throw new HttpsError7("not-found", "No se encuentra el restaurante.");
  if (!hasModule(restaurant, "reservations")) failure("El m\xF3dulo de reservas est\xE1 desactivado.");
  if (request) {
    const member = await membership(tx, rid, uidOf(request));
    if (!member.active || !can(member.role, permission2) || member.locationIds.length && !member.locationIds.includes(lid))
      throw new HttpsError7("permission-denied", "No tienes permiso para gestionar las reservas de este local.");
  }
  const location = await tx.get(local);
  if (!location.exists) throw new HttpsError7("not-found", "No se encuentra el local.");
  const incrementLock = await reservationLock(tx, local.path);
  const settingsDoc = await tx.get(local.collection("settings").doc("reservations"));
  const settings2 = settingsDoc.exists ? ReservationSettingsSchema.parse(settingsDoc.data()) : defaultReservationSettings(restaurant.timezone);
  if (publicBooking && !settings2.publicBooking) failure("El local no acepta reservas por la web.");
  const tables2 = (await tx.get(local.collection("tables"))).docs.map((d) => tableToMesa(d.id, TableSchema.parse(d.data())));
  const reservations = (await tx.get(local.collection("reservations"))).docs.map((d) => ({ id: d.id, ...ReservationSchema.parse(d.data()) }));
  const waitlist = (await tx.get(local.collection("waitlist"))).docs.map((d) => ({ id: d.id, ...WaitlistEntrySchema.parse(d.data()) }));
  const now = Date.now();
  const sessions = await readServiceSessions(tx, local.path);
  const occupancy2 = [...serviceOccupancy(reservations, sessions, settings2, now), ...waitlist.flatMap((w) => offeredOccupancy(w.id, w, settings2, now))];
  return { rid, lid, root, local, restaurant, location: location.data(), settings: settings2, config: settingsToConfiguracion(settings2), tables: tables2, reservations, occupancy: occupancy2, now, incrementLock };
}
function lock(tx, c) {
  c.incrementLock();
}
function find(c, id2) {
  const r = c.reservations.find((r2) => r2.id === id2);
  if (!r) throw new HttpsError7("not-found", "No se encuentra la reserva.");
  return r;
}
function proposals(c, startAt, partySize, durationMinutes, reservationId, preferredAreaId, limit = 1e4) {
  return proponerMesas({ config: c.config, mesas: c.tables, reservas: c.occupancy, ahora: c.now, peticion: { inicio: startAt, comensales: partySize, duracionMinutos: durationMinutes, reservaId: reservationId, zonaPreferida: preferredAreaId }, limite: limit });
}
function selection(c, r, tableIds, id2) {
  const result = proposals(c, r.startAt, r.partySize, r.durationMinutes, id2);
  if (!result.propuestas.length) failure("No queda sitio para esta reserva.");
  if (tableIds.length && !result.propuestas.some((p) => p.mesaIds.length === tableIds.length && p.mesaIds.every((t) => tableIds.includes(t)))) failure("Las mesas elegidas no est\xE1n disponibles o no admiten al grupo.");
  return result.propuestas[0];
}
function availability(c, date, partySize, durationMinutes, skip = false, exclude) {
  return calcularDisponibilidad({ config: c.config, fecha: date, comensales: partySize, mesas: c.tables, reservas: c.occupancy, ahora: c.now, duracionMinutos: durationMinutes, ignorarLimitesPublicos: skip, excluirReservaId: exclude });
}
function start(c, date, time, partySize, durationMinutes, skip = false, exclude) {
  const slot = slotStartAt(c.config, date, time);
  if (!slot) failure("Esa hora no existe en la zona horaria del local.");
  const available = availability(c, date, partySize, durationMinutes, skip, exclude);
  if (slot.inShift ? !available.franjas.some((f) => f.inicio === slot.startAt && f.disponible) : !skip) failure("Esa franja ya no est\xE1 disponible.");
  return slot.startAt;
}
function notices(tx, c, id2, r, token2) {
  const data = { guestName: r.guestName, restaurantName: c.restaurant.name, locationName: c.location.name, reference: r.reference, startAt: r.startAt, partySize: r.partySize, timezone: c.settings.timezone, amountCents: r.deposit.amountCents, slug: c.restaurant.slug, locationId: c.lid };
  if (token2) data.manageUrl = `/r/${c.restaurant.slug}/reserva/${r.reference}?t=${token2}`;
  const send = (template, sendAt) => {
    for (const channel of ["whatsapp", "email"]) {
      const to = channel === "email" ? r.email : r.phone;
      if (to) enqueueMessage(tx, c.rid, { channel, to, template, language: r.language, data, reservationId: id2, waitlistId: null, sendAt });
    }
  };
  if (r.status === "cancelled") {
    send("cancellation", c.now);
    return;
  }
  if (!["pending", "confirmed"].includes(r.status)) return;
  send(r.status === "confirmed" ? "confirmation" : "pending", c.now);
  if (r.deposit.status === "required") send("deposit_request", c.now);
  if (c.settings.reminders.dayBefore) {
    const day = sumarDias(horaLocal(r.startAt, c.settings.timezone).fecha, -1);
    const at = instanteDeHoraLocal(day, horaAMinutos(c.settings.reminders.hour), c.settings.timezone);
    if (at !== null && at > c.now && at < r.startAt) send("reminder", at);
  }
}
async function pendingMessages(tx, c, id2) {
  return (await tx.get(c.root.collection("messages").where("reservationId", "==", id2))).docs.filter((d) => d.data().status === "queued");
}
function write(tx, c, id2, r, fresh = false, actorUid = null) {
  tx.set(c.local.collection("reservations").doc(id2), { ...reservationForWrite(ReservationSchema.parse(r), Timestamp6.fromMillis), updatedBy: actorUid, ...fresh ? stamp() : { updatedAt: FieldValue4.serverTimestamp() } }, { merge: true });
  lock(tx, c);
}
async function create(tx, c, input, uid, publicRequest = false, dryRun = false) {
  const startAt = start(c, input.date, input.time, input.partySize, input.durationMinutes, input.skipWebLimits ?? false);
  const amountCents = publicRequest ? depositAmountFor(c.settings.deposit, input.partySize) : 0;
  const status = publicRequest ? amountCents || !c.settings.autoConfirm ? "pending" : "confirmed" : input.status ?? "confirmed";
  const token2 = linkToken(randomBytes3(32));
  const reference = reservationReference(randomBytes3(16));
  const ref = c.root.collection("reservationReferences").doc(reference);
  if ((await tx.get(ref)).exists) throw new HttpsError7("aborted", "Repite la operaci\xF3n para obtener otra referencia.");
  const id2 = c.local.collection("reservations").doc().id;
  const r = { guestName: input.guestName, phone: input.phone, email: input.email, language: input.language, partySize: input.partySize, startAt, durationMinutes: input.durationMinutes ?? duracionParaGrupo(c.config, input.partySize), status, tableIds: input.tableIds ?? [], suggestedTableIds: [], suggestionReason: null, source: input.source, notes: input.notes ?? "", guestNotes: input.guestNotes ?? "", customerId: customerIdFor(c.rid, input.phone), reference, manageTokenHash: sha256Hex(token2), deposit: { status: amountCents ? process.env.STRIPE_SECRET_KEY ? "required" : "not_configured" : "none", amountCents, checkoutSessionId: null }, history: [], createdBy: uid };
  if (occupiesTable(status)) {
    const suggestion = selection(c, r, r.tableIds);
    r.suggestedTableIds = suggestion.mesaIds;
    r.suggestionReason = suggestion.explicacion;
  }
  if (!dryRun) {
    tx.create(ref, { locationId: c.lid, reservationId: id2 });
    write(tx, c, id2, r, true, uid);
    notices(tx, c, id2, r, token2);
  }
  return { reservationId: id2, reference, status, startAt, tableIds: r.tableIds, suggestedTableIds: r.suggestedTableIds, manageToken: token2, deposit: r.deposit };
}
var consultarDisponibilidad = callable("consultarDisponibilidad", (d) => db.runTransaction(async (tx) => {
  const c = await context2(tx, await restaurantId(tx, d.slug), d.locationId, void 0, void 0, true);
  return disponibilidadToOutput(availability(c, d.date, d.partySize), { timezone: c.settings.timezone, waitlistEnabled: c.settings.waitlist.enabled });
}));
var crearReservaPublica = callable("crearReservaPublica", (d) => db.runTransaction(async (tx) => create(tx, await context2(tx, await restaurantId(tx, d.slug), d.locationId, void 0, void 0, true), d, null, true)));
var crearReserva = callable("crearReserva", (d, req) => db.runTransaction(async (tx) => create(tx, await context2(tx, d.restaurantId, d.locationId, req), d, uidOf(req))));
async function linked(tx, d) {
  const rid = await restaurantId(tx, d.slug);
  const ref = (await tx.get(db.doc(`restaurants/${rid}/reservationReferences/${d.reference}`))).data();
  if (!ref) throw new HttpsError7("not-found", "El enlace de reserva no es v\xE1lido.");
  const c = await context2(tx, rid, ref.locationId);
  const r = find(c, ref.reservationId);
  if (!timingSafeEqual(Buffer.from(r.manageTokenHash), Buffer.from(sha256Hex(d.token)))) throw new HttpsError7("permission-denied", "El enlace de reserva no es v\xE1lido.");
  return { c, r };
}
function view(c, r) {
  const unpaid = ["required", "not_configured", "failed"].includes(r.deposit.status);
  return { ...r, timezone: c.settings.timezone, locationId: c.lid, locationName: c.location.name, freeCancellationUntil: c.settings.cancellation.freeUntilHours ? r.startAt - c.settings.cancellation.freeUntilHours * 36e5 : null, canConfirm: !unpaid && canTransition(r.status, "confirmed", r.startAt, c.now), canCancel: canTransition(r.status, "cancelled", r.startAt, c.now) };
}
async function change(tx, c, r, status, by, reason) {
  const changed = applyStatusChange(r, status, { nowMs: c.now, by, reason });
  if (!changed.ok) failure(changed.reason);
  const next = changed.ok ? changed.reservation : r;
  if (occupiesTable(status)) selection(c, next, next.tableIds, r.id);
  const pending = await pendingMessages(tx, c, r.id);
  for (const doc of pending) tx.update(doc.ref, { status: "cancelled", updatedAt: FieldValue4.serverTimestamp() });
  write(tx, c, r.id, next, false, by);
  if (status === "confirmed" || status === "cancelled") notices(tx, c, r.id, next);
  return next;
}
var verReservaPublica = callable("verReservaPublica", (d) => db.runTransaction(async (tx) => {
  const { c, r } = await linked(tx, d);
  return view(c, r);
}));
var gestionarReservaPublica = callable("gestionarReservaPublica", (d) => db.runTransaction(async (tx) => {
  const { c, r } = await linked(tx, d);
  if (d.action === "confirm" && !view(c, r).canConfirm) failure("La reserva no se puede confirmar; comprueba la se\xF1al pendiente.");
  return view(c, await change(tx, c, r, d.action === "confirm" ? "confirmed" : "cancelled", null, d.reason));
}));
var cambiarEstadoReserva = callable("cambiarEstadoReserva", (d, req) => db.runTransaction(async (tx) => {
  const c = await context2(tx, d.restaurantId, d.locationId, req);
  const open = d.status === "seated" && hasModule(c.restaurant, "floor") ? await prepareSeatReservation(tx, d.restaurantId, d.locationId, d.reservationId, req) : null;
  const close = d.status === "finished" && hasModule(c.restaurant, "floor") ? await prepareFinishReservation(tx, d.restaurantId, d.locationId, d.reservationId, req) : null;
  if (!(open && find(c, d.reservationId).status === "seated")) await change(tx, c, find(c, d.reservationId), d.status, uidOf(req), d.reason);
  open?.();
  close?.();
  return { ok: true, status: d.status };
}));
var asignarMesas = callable("asignarMesas", (d, req) => db.runTransaction(async (tx) => {
  const c = await context2(tx, d.restaurantId, d.locationId, req);
  const r = find(c, d.reservationId);
  await checkReservationPosLock(tx, d.restaurantId, d.locationId, d.reservationId);
  if (!occupiesTable(r.status)) failure("Esta reserva ya no ocupa mesa.");
  selection(c, r, d.tableIds, r.id);
  write(tx, c, r.id, { ...r, tableIds: d.tableIds }, false, uidOf(req));
  return { ok: true, tableIds: d.tableIds };
}));
var moverReserva = callable("moverReserva", (d, req) => db.runTransaction(async (tx) => {
  const c = await context2(tx, d.restaurantId, d.locationId, req);
  const old = find(c, d.reservationId);
  if (!["pending", "confirmed"].includes(old.status)) failure("Solo se pueden mover reservas pendientes o confirmadas.");
  const partySize = d.partySize ?? old.partySize;
  const durationMinutes = d.durationMinutes ?? duracionParaGrupo(c.config, partySize);
  const r = { ...old, partySize, durationMinutes, startAt: start(c, d.date, d.time, partySize, durationMinutes, true, old.id), tableIds: d.tableIds ?? old.tableIds };
  const p = proposals(c, r.startAt, partySize, durationMinutes, old.id);
  if (d.tableIds === void 0 && !p.propuestas.some((p2) => p2.mesaIds.length === r.tableIds.length && p2.mesaIds.every((t) => r.tableIds.includes(t)))) r.tableIds = [];
  const suggestion = selection(c, r, r.tableIds, old.id);
  r.suggestedTableIds = suggestion.mesaIds;
  r.suggestionReason = suggestion.explicacion;
  const pending = await pendingMessages(tx, c, r.id);
  for (const doc of pending) tx.update(doc.ref, { status: "cancelled", updatedAt: FieldValue4.serverTimestamp() });
  write(tx, c, r.id, r, false, uidOf(req));
  notices(tx, c, r.id, r);
  return { ok: true, ...r };
}));
var proponerMesasReserva = callable("proponerMesasReserva", (d, req) => db.runTransaction(async (tx) => {
  const c = await context2(tx, d.restaurantId, d.locationId, req);
  const r = d.reservationId ? find(c, d.reservationId) : void 0;
  const wall = r ? horaLocal(r.startAt, c.settings.timezone) : void 0;
  const startAt = d.date || d.time ? slotStartAt(c.config, d.date ?? wall.fecha, d.time ?? minutosAHora(wall.minutos))?.startAt : r?.startAt;
  if (startAt === void 0) failure("Indica una fecha y hora v\xE1lidas.");
  return asignacionToOutput(proposals(c, startAt, d.partySize ?? r.partySize, d.durationMinutes ?? r?.durationMinutes, r?.id, d.preferredAreaId, d.limit));
}));
var guardarConfiguracionReservas = callable("guardarConfiguracionReservas", (d, req) => db.runTransaction(async (tx) => {
  const c = await context2(tx, d.restaurantId, d.locationId, req, "reservas.configurar");
  tx.set(c.local.collection("settings").doc("reservations"), { ...d.settings, ...stamp(), updatedBy: uidOf(req) });
  lock(tx, c);
  return { ok: true };
}));
var cambiarPlan = callable("cambiarPlan", (d, req) => db.runTransaction(async (tx) => {
  uidOf(req);
  if (req.auth?.token.logiqd !== true) throw new HttpsError7("permission-denied", "Solo el equipo de LogiQD puede cambiar el plan.");
  const ref = db.doc(`restaurants/${d.restaurantId}`);
  if (!(await tx.get(ref)).exists) throw new HttpsError7("not-found", "No se encuentra el restaurante.");
  const activeModules = activeModulesFor(d.plan, d.moduleOverrides);
  tx.update(ref, { plan: d.plan, moduleOverrides: d.moduleOverrides, activeModules, updatedAt: FieldValue4.serverTimestamp() });
  return { ok: true, plan: d.plan, activeModules };
}));
var importarReservas = callable("importarReservas", async (d, req) => {
  await db.runTransaction((tx) => context2(tx, d.restaurantId, d.locationId, req, "reservas.importar"));
  const errors = [], reservationIds = [];
  for (const [index, raw] of d.rows.entries()) {
    const row = parseImportRow(raw, index);
    if (!row.ok) {
      errors.push(...row.errors);
      continue;
    }
    try {
      const result = await db.runTransaction(async (tx) => {
        const c = await context2(tx, d.restaurantId, d.locationId, req, "reservas.importar");
        const tableIds = row.value.tables.map((name) => {
          const table = c.tables.find((t) => t.name === name);
          if (!table) failure(`No existe la mesa ${name}.`);
          return table.id;
        });
        return create(tx, c, { ...row.value, source: "import", skipWebLimits: true, tableIds }, uidOf(req), false, d.dryRun);
      });
      if (!d.dryRun) reservationIds.push(result.reservationId);
    } catch (error) {
      if (error instanceof HttpsError7 && ["unauthenticated", "permission-denied"].includes(error.code)) throw error;
      errors.push({ row: index, field: null, message: error instanceof HttpsError7 ? error.message : "No se ha podido importar la fila." });
    }
  }
  return { created: reservationIds.length, reservationIds, errors };
});
async function prepareReservationNotices(tx, rid, lid, id2, r) {
  const c = await context2(tx, rid, lid);
  const pending = await pendingMessages(tx, c, id2);
  return () => {
    for (const doc of pending) tx.update(doc.ref, { status: "cancelled", updatedAt: FieldValue4.serverTimestamp() });
    if (r.status === "confirmed" || r.status === "cancelled") notices(tx, c, id2, r);
  };
}

// src/deposit/stripe.ts
import { onCall as onCall8, onRequest, HttpsError as HttpsError8 } from "firebase-functions/v2/https";
import { Timestamp as Timestamp7 } from "firebase-admin/firestore";

// src/webhooks/signatures.ts
import { createHmac, timingSafeEqual as timingSafeEqual2 } from "crypto";
function equalHex(a, b) {
  return /^[a-f0-9]{64}$/i.test(a) && timingSafeEqual2(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}
function verifyWhatsApp(raw, signature, secret) {
  return !!secret && signature.startsWith("sha256=") && equalHex(signature.slice(7), createHmac("sha256", secret).update(raw).digest("hex"));
}
function verifyStripe(raw, signature, secret, now = Date.now()) {
  const fields = signature.split(",").map((s) => s.trim().split("="));
  const t = fields.find((f) => f[0] === "t")?.[1];
  if (!secret || !t || !/^\d+$/.test(t) || Math.abs(now / 1e3 - Number(t)) > 300) return false;
  const hash2 = createHmac("sha256", secret).update(`${t}.`).update(raw).digest("hex");
  return fields.some((f) => f[0] === "v1" && equalHex(f[1] ?? "", hash2));
}

// src/deposit/stripe.ts
var iniciarPagoSenal = onCall8(options, (request) => safe(async () => {
  const data = parse(CALLABLE_SCHEMAS[CALLABLES.iniciarPagoSenal].input, request.data);
  const { rid } = await publicContext(data.slug);
  const { ref, reservation: r } = await linkedReservation(rid, data.reference, sha256Hex(data.token));
  if (r.deposit.status === "paid") return { status: "already_paid" };
  if (!r.deposit.amountCents || r.deposit.status === "none") return { status: "not_required" };
  if (!["pending", "confirmed"].includes(r.status)) throw new HttpsError8("failed-precondition", "Esta reserva ya no admite el pago de la se\xF1al.");
  if (!process.env.STRIPE_SECRET_KEY) return { status: "not_configured", message: "Los pagos de se\xF1al no est\xE1n configurados. Contacta con el restaurante." };
  const base = process.env.PUBLIC_APP_URL;
  if (!base || !/^https:\/\//.test(base)) throw new HttpsError8("failed-precondition", "Falta configurar la direcci\xF3n p\xFAblica de reservas.");
  const url = `${base}/r/${data.slug}/reserva/${r.reference}?t=${data.token}`;
  const form = new URLSearchParams({ mode: "payment", success_url: url, cancel_url: url, "line_items[0][price_data][currency]": "eur", "line_items[0][price_data][unit_amount]": String(r.deposit.amountCents), "line_items[0][price_data][product_data][name]": `Se\xF1al de reserva ${r.reference}`, "line_items[0][quantity]": "1", "metadata[reservationPath]": ref.path });
  const response = await fetch("https://api.stripe.com/v1/checkout/sessions", { method: "POST", headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": `deposit_${sha256Hex(ref.path)}_${r.deposit.amountCents}` }, body: form.toString(), signal: AbortSignal.timeout(15e3) });
  if (!response.ok) throw new HttpsError8("unavailable", "No se ha podido iniciar el pago de la se\xF1al.");
  const session = external_exports.object({ id: external_exports.string(), url: external_exports.string().regex(/^https:\/\//) }).parse(await response.json());
  await db.runTransaction(async (tx) => {
    const current = parse(ReservationSchema, (await tx.get(ref)).data());
    if (current.deposit.status === "paid") return;
    if (current.deposit.amountCents !== r.deposit.amountCents || !["pending", "confirmed"].includes(current.status)) throw new HttpsError8("aborted", "La reserva ha cambiado. Vuelve a intentarlo.");
    tx.update(ref, { deposit: { ...current.deposit, status: "required", checkoutSessionId: session.id }, updatedAt: Timestamp7.now() });
  });
  return { status: "redirect", url: session.url };
}));
var eventSchema = external_exports.object({ id: external_exports.string(), type: external_exports.string(), data: external_exports.object({ object: external_exports.object({ id: external_exports.string(), metadata: external_exports.object({ reservationPath: external_exports.string() }).optional(), payment_status: external_exports.string().optional(), amount_total: external_exports.number().optional(), currency: external_exports.string().optional() }) }) });
async function handleStripe(body) {
  const event = eventSchema.parse(body), session = event.data.object;
  if (event.type !== "checkout.session.completed" || session.payment_status !== "paid") return;
  const path = session.metadata?.reservationPath;
  if (!path || !/^restaurants\/[^/]+\/locations\/[^/]+\/reservations\/[^/]+$/.test(path)) return;
  await db.runTransaction(async (tx) => {
    const ref = db.doc(path), snap = await tx.get(ref);
    if (!snap.exists) return;
    const r = parse(ReservationSchema, snap.data());
    if (r.deposit.status === "paid") return;
    if (r.deposit.checkoutSessionId !== session.id || r.deposit.amountCents !== session.amount_total || session.currency !== "eur") throw new Error("El pago no corresponde a la se\xF1al.");
    const change2 = r.status === "pending" ? applyStatusChange(r, "confirmed", { nowMs: Date.now(), reason: "Se\xF1al pagada" }) : null;
    const incrementLock = await reservationLock(tx, ref.parent.parent.path);
    const next = { ...change2?.ok ? change2.reservation : r, deposit: { ...r.deposit, status: "paid" } };
    const notices2 = change2?.ok ? await prepareReservationNotices(tx, path.split("/")[1], path.split("/")[3], ref.id, next) : null;
    incrementLock();
    notices2?.();
    tx.update(ref, { ...reservationForWrite(change2?.ok ? change2.reservation : r, Timestamp7.fromMillis), deposit: { ...r.deposit, status: "paid" }, updatedAt: Timestamp7.now() });
  });
}
var stripeWebhook = onRequest(options, async (req, res) => {
  if (req.method !== "POST") {
    res.status(405).send("M\xE9todo no permitido.");
    return;
  }
  if (!verifyStripe(req.rawBody, req.get("Stripe-Signature") ?? "", process.env.STRIPE_WEBHOOK_SECRET ?? "")) {
    res.status(401).send("Firma incorrecta.");
    return;
  }
  try {
    await handleStripe(req.body);
    res.status(200).send("OK");
  } catch {
    res.status(500).send("No se ha podido procesar el pago.");
  }
});

// src/webhooks/whatsapp.ts
import { onRequest as onRequest2 } from "firebase-functions/v2/https";
import { Timestamp as Timestamp8 } from "firebase-admin/firestore";
var payload = external_exports.object({ entry: external_exports.array(external_exports.object({ changes: external_exports.array(external_exports.object({ value: external_exports.object({ messages: external_exports.array(external_exports.object({ id: external_exports.string(), from: external_exports.string(), context: external_exports.object({ id: external_exports.string() }).optional(), interactive: external_exports.object({ button_reply: external_exports.object({ id: external_exports.string() }) }).optional(), button: external_exports.object({ text: external_exports.string(), payload: external_exports.string() }).optional(), text: external_exports.object({ body: external_exports.string() }).optional() })).optional() }) })) })) });
async function handleWhatsApp(body) {
  for (const entry of payload.parse(body).entry) for (const change2 of entry.changes) for (const incoming of change2.value.messages ?? []) {
    const reply = incoming.interactive?.button_reply.id ?? incoming.button?.payload;
    let messagePath = reply?.replace(/:(confirm|cancel)$/, "");
    const action = reply?.endsWith(":cancel") ? "cancelled" : reply?.endsWith(":confirm") ? "confirmed" : /^(cancelar|cancel·lar|cancel)$/i.test(incoming.text?.body ?? incoming.button?.text ?? "") ? "cancelled" : /^(confirmo|confirm)$/i.test(incoming.text?.body ?? incoming.button?.text ?? "") ? "confirmed" : null;
    if (!action) continue;
    if (!messagePath && incoming.context?.id) {
      const found = await db.collectionGroup("messages").where("providerMessageId", "==", incoming.context.id).limit(1).get();
      messagePath = found.docs[0]?.ref.path;
    }
    if (!messagePath || !/^restaurants\/[^/]+\/messages\/[^/]+$/.test(messagePath)) continue;
    const rid = messagePath.split("/")[1];
    const messageDoc = await db.doc(messagePath).get();
    const message = parse(MessageSchema, messageDoc.data());
    if (message.channel !== "whatsapp" || message.to !== `+${incoming.from}` || !message.reservationId || !["sent", "captured"].includes(message.status)) continue;
    const locations = await db.collection(`restaurants/${rid}/locations`).get();
    for (const location of locations.docs) {
      const ref = location.ref.collection("reservations").doc(message.reservationId);
      await db.runTransaction(async (tx) => {
        const dedup = db.doc(`restaurants/${rid}/r2WebhookEvents/${sha256Hex(incoming.id)}`);
        const [seen, snap] = await Promise.all([tx.get(dedup), tx.get(ref)]);
        if (seen.exists || !snap.exists) return;
        const reservation = parse(ReservationSchema, snap.data());
        if (reservation.phone !== message.to || action === "confirmed" && ["required", "not_configured", "failed"].includes(reservation.deposit.status)) return;
        const changed = applyStatusChange(reservation, action, { nowMs: Date.now(), reason: "Respuesta por WhatsApp" });
        if (!changed.ok) return;
        const incrementLock = await reservationLock(tx, location.ref.path);
        const notices2 = await prepareReservationNotices(tx, rid, location.id, ref.id, changed.reservation);
        incrementLock();
        notices2();
        tx.update(ref, { ...reservationForWrite(changed.reservation, Timestamp8.fromMillis), updatedAt: Timestamp8.now() });
        tx.create(dedup, stamp());
      });
    }
  }
}
var whatsappWebhook = onRequest2(options, async (req, res) => {
  if (req.method === "GET") {
    if (process.env.WHATSAPP_VERIFY_TOKEN && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === process.env.WHATSAPP_VERIFY_TOKEN) res.status(200).send(req.query["hub.challenge"]);
    else res.status(403).send("Verificaci\xF3n incorrecta.");
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("M\xE9todo no permitido.");
    return;
  }
  if (!verifyWhatsApp(req.rawBody, req.get("X-Hub-Signature-256") ?? "", process.env.WHATSAPP_APP_SECRET ?? "")) {
    res.status(401).send("Firma incorrecta.");
    return;
  }
  try {
    await handleWhatsApp(req.body);
    res.status(200).send("OK");
  } catch {
    res.status(500).send("No se ha podido procesar el evento.");
  }
});

// src/reservationTriggers.ts
import { createHash as createHash2 } from "crypto";
import { onDocumentWritten } from "firebase-functions/v2/firestore";
import { Timestamp as Timestamp9 } from "firebase-admin/firestore";
var reservationChanged = onDocumentWritten({ ...options, document: "restaurants/{rid}/locations/{lid}/reservations/{id}" }, async (event) => {
  if (!event.data) return;
  const after = event.data.after.data(), before = event.data.before.data();
  const data = after ?? before;
  if (!data) return;
  const r = ReservationSchema.parse(data);
  const root = db.doc(`restaurants/${event.params.rid}`);
  const eventRef = root.collection("activity").doc(createHash2("sha256").update(event.id).digest("hex"));
  await db.runTransaction(async (tx) => {
    if ((await tx.get(eventRef)).exists) return;
    const actorUid = "updatedBy" in data ? data.updatedBy : r.history.at(-1)?.by ?? r.createdBy;
    const actor = actorUid ? (await tx.get(db.doc(`users/${actorUid}`))).data() : void 0;
    const customerRef = root.collection("customers").doc(r.customerId);
    const old = await tx.get(customerRef);
    const locations = await tx.get(root.collection("locations"));
    const reservations = [];
    for (const local of locations.docs) {
      const rows = await tx.get(local.ref.collection("reservations").where("customerId", "==", r.customerId));
      reservations.push(...rows.docs.map((d) => ReservationSchema.parse(d.data())));
    }
    const visits = reservations.filter((r2) => ["seated", "finished"].includes(r2.status));
    const customer2 = CustomerSchema.parse({ name: r.guestName, phone: r.phone, email: r.email, language: r.language, notes: "", allergies: "", tags: [], ...old.data(), visits: visits.length, noShows: reservations.filter((r2) => r2.status === "no_show").length, cancellations: reservations.filter((r2) => r2.status === "cancelled").length, lastVisitAt: visits.length ? Math.max(...visits.map((r2) => r2.startAt)) : null });
    tx.set(customerRef, { ...customerForWrite(customer2, Timestamp9.fromMillis), ...!old.exists ? stamp() : { updatedAt: Timestamp9.now() } }, { merge: true });
    const action = !before ? "created" : !after ? "deleted" : before.status !== after.status ? "statusChanged" : before.startAt?.toMillis() !== after.startAt?.toMillis() ? "moved" : "tablesChanged";
    tx.create(eventRef, { action: `reservation.${action}`, summary: `Reserva ${r.reference}: ${RESERVATION_STATUS_LABEL[r.status]}`, actorUid, actorName: actor?.displayName ?? null, entity: { type: "reservation", id: event.params.id }, ...stamp() });
  });
});
async function syncPublicRestaurant(rid, previousSlug) {
  await db.runTransaction(async (tx) => {
    const root = db.doc(`restaurants/${rid}`);
    const restaurant = (await tx.get(root)).data();
    const locations = await tx.get(root.collection("locations"));
    const publicLocations = [];
    let first;
    for (const local of locations.docs) {
      const raw = await tx.get(local.ref.collection("settings").doc("reservations"));
      const settings3 = raw.exists ? ReservationSettingsSchema.parse(raw.data()) : defaultReservationSettings(restaurant?.timezone);
      first ??= settings3;
      if (settings3.publicBooking) publicLocations.push(PublicLocationSchema.parse({ id: local.id, ...local.data() }));
    }
    if (previousSlug && previousSlug !== restaurant?.slug) tx.delete(db.doc(`publicRestaurants/${previousSlug}`));
    if (!restaurant) return;
    const settings2 = first ?? defaultReservationSettings(restaurant.timezone);
    const enabled = hasModule(restaurant, "reservations");
    const data = PublicRestaurantSchema.parse({ restaurantId: rid, ...restaurant, bookingEnabled: enabled && publicLocations.length > 0, bookingDisabledReason: !enabled ? "module_off" : publicLocations.length ? null : "public_booking_off", locations: publicLocations, minPartySize: settings2.minPartySize, maxPartySize: settings2.maxPartySize, maxAdvanceDays: settings2.maxAdvanceDays, deposit: settings2.deposit, cancellationFreeUntilHours: settings2.cancellation.freeUntilHours });
    tx.set(db.doc(`publicRestaurants/${restaurant.slug}`), { ...data, ...stamp() });
  });
}
var publicRestaurantChanged = onDocumentWritten({ ...options, document: "restaurants/{rid}" }, (event) => syncPublicRestaurant(event.params.rid, event.data?.before.data()?.slug));
var publicLocationChanged = onDocumentWritten({ ...options, document: "restaurants/{rid}/locations/{lid}" }, (event) => {
  const before = event.data?.before.data(), after = event.data?.after.data();
  if (before && after && ["name", "address", "city", "phone", "slug"].every((k) => before[k] === after[k])) return;
  return syncPublicRestaurant(event.params.rid);
});
var publicSettingsChanged = onDocumentWritten({ ...options, document: "restaurants/{rid}/locations/{lid}/settings/reservations" }, (event) => syncPublicRestaurant(event.params.rid));

// src/fase2/index.ts
import { onCall as onCall9, HttpsError as HttpsError11 } from "firebase-functions/v2/https";

// src/fase2/catalog.ts
var catalog_exports = {};
__export(catalog_exports, {
  guardarCategoriaCarta: () => guardarCategoriaCarta,
  guardarConfiguracionSala: () => guardarConfiguracionSala,
  guardarEstacion: () => guardarEstacion,
  guardarMenuDia: () => guardarMenuDia,
  guardarPlato: () => guardarPlato,
  marcarAgotado: () => marcarAgotado,
  ordenarCarta: () => ordenarCarta,
  regenerarQrMesa: () => regenerarQrMesa
});
import { randomBytes as randomBytes4 } from "crypto";
import { Timestamp as Timestamp10 } from "firebase-admin/firestore";
function guardarCategoriaCarta(c, d) {
  const id2 = d.categoryId ?? newId(c, "menuCategories");
  if (d.categoryId) get(c, "menuCategories", id2);
  c.put("menuCategories", { ...d.category, id: id2 }, !d.categoryId);
  return { ok: true, categoryId: id2 };
}
function guardarPlato(c, d) {
  const id2 = d.itemId ?? newId(c, "menuItems");
  const old = d.itemId ? get(c, "menuItems", id2) : null;
  get(c, "menuCategories", d.item.categoryId);
  if (d.item.stationId) get(c, "stations", d.item.stationId);
  if (d.item.photoPath && !d.item.photoPath.startsWith(`${c.local.path}/menu/${id2}/`)) fail("La foto debe pertenecer a este plato y local.");
  const version = nextItemVersion(old, d.item);
  c.put("menuItems", { ...d.item, id: id2, soldOut: old?.soldOut ?? false, version }, !old);
  return { ok: true, itemId: id2, version, priceChanged: !!old && old.version !== version };
}
function guardarMenuDia(c, d) {
  const id2 = d.dailyMenuId ?? newId(c, "dailyMenus");
  const old = d.dailyMenuId ? get(c, "dailyMenus", id2) : null;
  for (const section of d.menu.sections) for (const choice of section.choices) {
    const item = get(c, "menuItems", choice.itemId);
    if (choice.variantId && !item.variants.some((v) => v.id === choice.variantId)) fail("La variante no pertenece al plato del men\xFA.");
  }
  const version = nextDailyMenuVersion(old, d.menu);
  c.put("dailyMenus", { ...d.menu, id: id2, version }, !old);
  return { ok: true, dailyMenuId: id2, version, priceChanged: !!old && old.version !== version };
}
function ordenarCarta(c, d) {
  for (const row of d.categories ?? []) c.put("menuCategories", { ...get(c, "menuCategories", row.id), sortOrder: row.sortOrder });
  for (const row of d.items ?? []) {
    get(c, "menuCategories", row.categoryId);
    c.put("menuItems", { ...get(c, "menuItems", row.id), categoryId: row.categoryId, sortOrder: row.sortOrder });
  }
  return { ok: true };
}
function marcarAgotado(c, d) {
  const item = get(c, "menuItems", d.itemId);
  if (c.actor?.role === "kitchen" || c.actor?.role === "bar") {
    const station = resolveStation(item.stationId, Object.fromEntries(c.rows.stations), c.settings.defaultStationId);
    if (!station || station.station.kind !== c.actor.role) denied();
  }
  if (d.optionId) {
    if (!item.modifierGroups.some((g) => g.options.some((o) => o.id === d.optionId))) fail("El extra no pertenece a este plato.");
    c.put("menuItems", { ...item, modifierGroups: item.modifierGroups.map((g) => ({ ...g, options: g.options.map((o) => o.id === d.optionId ? { ...o, soldOut: d.soldOut } : o) })) });
  } else c.put("menuItems", { ...item, soldOut: d.soldOut });
  return { ok: true, soldOut: d.soldOut };
}
function guardarEstacion(c, d) {
  const id2 = d.stationId ?? newId(c, "stations");
  if (d.stationId) get(c, "stations", id2);
  c.put("stations", { ...d.station, id: id2 }, !d.stationId);
  return { ok: true, stationId: id2 };
}
function guardarConfiguracionSala(c, d) {
  if (d.settings.defaultStationId) get(c, "stations", d.settings.defaultStationId);
  c.settings = d.settings;
  c.stage(`${c.local.path}/settings/floor`, d.settings, !c.floorExists);
  return { ok: true };
}
function regenerarQrMesa(c, d) {
  const tokens = d.tableIds.map((tableId) => {
    if (!get(c, "tables", tableId).enabled) fail("La mesa est\xE1 desactivada.");
    const token2 = linkToken(randomBytes4(32));
    c.secret("tableTokens", tableId, { tokenHash: sha256Hex(token2), rotatedAt: Timestamp10.fromMillis(c.now) });
    return { tableId, token: token2, path: tableQrPath(c.restaurant.slug, c.lid, tableId, token2) };
  });
  return { tokens };
}

// src/fase2/orders.ts
var orders_exports = {};
__export(orders_exports, {
  cambiarEstadoLineas: () => cambiarEstadoLineas,
  decide: () => decide,
  decidirPedido: () => decidirPedido,
  enviarPedido: () => enviarPedido,
  marcharPase: () => marcharPase,
  placeOrder: () => placeOrder
});
function placeOrder(c, d) {
  const dest = destination(c, d.sessionId, d.takeawayId);
  const takeaway = d.takeawayId ? get(c, "takeaways", d.takeawayId) : null;
  if (takeaway && d.source === "staff" && !["accepted", "ready"].includes(takeaway.status)) fail("Acepta primero el pedido para llevar.");
  if (takeaway && takeaway.orderIds.length >= 20) fail("Este pedido ya tiene el m\xE1ximo de env\xEDos.");
  const catalog = d.source === "staff" ? { items: Object.fromEntries(c.rows.menuItems), dailyMenus: Object.fromEntries(c.rows.dailyMenus) } : publicMenuCatalog(publicMenu(c));
  const priced = priceOrder(d.lines, catalog, { channel: takeaway ? "takeaway" : d.source === "staff" ? "staff" : "table", now: takeaway?.pickupAt ?? c.now, timezone: c.reservationSettings.timezone, expectedTotalCents: d.expectedTotalCents });
  if (!priced.ok) return { status: "rejected", problems: priced.problems, totalCents: priced.totalCents };
  const kitchen = hasModule(c.restaurant, "kitchen");
  const settings2 = kitchen ? c.settings : { ...c.settings, defaultStationId: null };
  const drafts = planOrderLines(priced.lines, Object.fromEntries(c.rows.menuItems), kitchen ? Object.fromEntries(c.rows.stations) : {}, settings2, Object.fromEntries(c.rows.dailyMenus));
  const orderId = newId(c, "orders"), ids = Object.fromEntries(drafts.map((l) => [l.key, newId(c, "orderLines")]));
  const existing = destinationLines(c, d.sessionId, d.takeawayId);
  const takeFiring = takeaway ? takeawayFiring(drafts, takeaway.pickupAt, c.settings.takeaway.prepLeadMinutes, c.now, d.fire) : null;
  const statuses = takeFiring?.statuses ?? firingFor(drafts, existing, d.fire, c.settings.firing.mode);
  for (const draft of drafts) {
    const { key, parentKey, ...fields } = draft;
    const status = d.pending ? "pending" : statuses[key];
    const line = {
      ...fields,
      id: ids[key],
      parentLineId: parentKey ? ids[parentKey] : null,
      orderId,
      sessionId: d.sessionId,
      takeawayId: d.takeawayId,
      label: dest.label,
      status,
      placedAt: c.now,
      fireAt: takeFiring?.fireAt ?? null,
      firedAt: status === "fired" ? c.now : null,
      startedAt: null,
      readyAt: null,
      servedAt: null,
      cancelReason: null,
      history: [],
      createdBy: c.uid
    };
    c.put("orderLines", line, true);
  }
  const lineIds = drafts.filter((l) => l.parentKey === null).map((l) => ids[l.key]);
  c.put("orders", {
    id: orderId,
    sessionId: d.sessionId,
    takeawayId: d.takeawayId,
    source: d.source,
    status: d.pending ? "pending_approval" : "accepted",
    lineIds,
    totalCents: priced.totalCents,
    note: d.note,
    language: d.language,
    fire: d.fire,
    placedAt: c.now,
    createdBy: c.uid,
    decidedBy: d.pending ? null : c.uid,
    decidedAt: d.pending ? null : c.now,
    rejectReason: null
  }, true);
  if (d.sessionId) {
    const s = get(c, "tableSessions", d.sessionId);
    if (s.status === "bill_requested") sessionStatus(c, s, "open");
    for (const t of c.rows.floorTasks.values()) if (t.sessionId === s.id && t.type === "bill_request") closeTask(c, t, "cancelled");
  }
  if (takeaway) c.put("takeaways", { ...takeaway, orderIds: [...takeaway.orderIds, orderId] });
  if (d.pending) task(c, { ...dest, type: "approve_order", sessionId: d.sessionId, takeawayId: d.takeawayId, orderId });
  reconcile(c);
  return {
    status: "sent",
    orderId,
    lineIds,
    totalCents: priced.totalCents,
    sessionTotalCents: sessionTotals(destinationLines(c, d.sessionId, d.takeawayId)).totalCents,
    fired: drafts.filter((l) => l.kind !== "menu" && !d.pending && statuses[l.key] === "fired").length,
    held: drafts.filter((l) => l.kind !== "menu" && !d.pending && statuses[l.key] === "held").length
  };
}
function enviarPedido(c, d) {
  return placeOrder(c, { ...d, source: "staff", language: "es", pending: false });
}
function decide(c, orderId, decision, reason, fire) {
  const order = get(c, "orders", orderId);
  if (order.status !== "pending_approval") fail("Este pedido ya se ha decidido.");
  destination(c, order.sessionId, order.takeawayId);
  if (decision === "reject" && !reason?.trim()) fail("Indica el motivo del rechazo.");
  const own = [...c.rows.orderLines.values()].filter((l) => l.orderId === orderId);
  if (!own.length || own.some((l) => l.status !== "pending")) fail("El pedido pendiente ha cambiado. Vuelve a consultarlo.");
  const take = order.takeawayId ? get(c, "takeaways", order.takeawayId) : null;
  const drafts = own.map((l) => ({ ...l, key: l.id, parentKey: l.parentLineId }));
  const statuses = take ? takeawayFiring(drafts, take.pickupAt, c.settings.takeaway.prepLeadMinutes, c.now, fire).statuses : firingFor(drafts, destinationLines(c, order.sessionId, null).filter((l) => l.orderId !== order.id), fire, c.settings.firing.mode);
  let fired = 0, held = 0;
  for (const l of own) {
    const status2 = decision === "reject" ? "cancelled" : statuses[l.id];
    if (l.kind !== "menu") {
      if (status2 === "fired") fired++;
      if (status2 === "held") held++;
    }
    lineStatus(c, l, status2, reason);
  }
  const status = decision === "reject" ? "rejected" : "accepted";
  c.put("orders", { ...order, status, decidedAt: c.now, decidedBy: c.uid, rejectReason: decision === "reject" ? reason : null, fire });
  for (const t of c.rows.floorTasks.values()) if (t.orderId === orderId && t.type === "approve_order") closeTask(c, t);
  return { ok: true, status, fired, held };
}
function decidirPedido(c, d) {
  const order = get(c, "orders", d.orderId);
  const result = decide(c, d.orderId, d.decision, d.reason ?? null, d.fire);
  if (order.takeawayId && d.decision === "accept") {
    const take = get(c, "takeaways", order.takeawayId);
    if (take.status === "pending") {
      c.put("takeaways", { ...take, status: "accepted", history: [...take.history, { from: "pending", to: "accepted", at: c.now, by: c.uid, reason: null }] });
    }
  }
  return result;
}
function marcharPase(c, d) {
  destination(c, d.sessionId, d.takeawayId);
  if (d.takeawayId && get(c, "takeaways", d.takeawayId).status === "pending") fail("Acepta primero el pedido para llevar.");
  const all = destinationLines(c, d.sessionId, d.takeawayId);
  const course = d.course ?? nextHeldCourse(all);
  const lines = linesToFire(all, d.course);
  for (const line of lines) lineStatus(c, line, "fired");
  return { ok: true, course, lineIds: lines.map((l) => l.id) };
}
function cambiarEstadoLineas(c, d) {
  const lines = d.lineIds.map((id2) => get(c, "orderLines", id2));
  for (const l of lines) {
    destination(c, l.sessionId, l.takeawayId);
    checkLine(c, l, d.status, d.reason ?? null);
  }
  for (const l of lines) lineStatus(c, l, d.status, d.reason ?? null);
  reconcile(c);
  const firedNext = [];
  if (d.status === "served") {
    const sessions = new Set(lines.map((l) => l.sessionId).filter((id2) => !!id2));
    for (const sessionId of sessions) for (const l of autoFireAfterServe(destinationLines(c, sessionId, null), c.settings)) {
      lineStatus(c, l, "fired");
      firedNext.push(l.id);
    }
  }
  return { ok: true, lines: d.lineIds.map((id2) => ({ id: id2, status: get(c, "orderLines", id2).status })), firedNext };
}

// src/fase2/tasks.ts
var tasks_exports = {};
__export(tasks_exports, {
  cambiarEstadoTarea: () => cambiarEstadoTarea,
  crearTarea: () => crearTarea
});
function crearTarea(c, d) {
  const dest = d.sessionId ? destination(c, d.sessionId, null) : { tableIds: d.tableIds, label: sessionLabel(d.tableIds, Object.fromEntries(c.rows.tables)) };
  for (const id2 of dest.tableIds) get(c, "tables", id2);
  const t = task(c, { type: "custom", sessionId: d.sessionId, takeawayId: null, ...dest, note: d.note });
  if (d.claim) {
    const result = claimTask(t, c.uid, c.actor.displayName, c.now);
    if (result.ok) c.put("floorTasks", result.task);
  }
  return { taskId: t.id };
}
function cambiarEstadoTarea(c, d) {
  const t = get(c, "floorTasks", d.taskId);
  if (d.action === "done" && t.type === "approve_order" && t.orderId && get(c, "orders", t.orderId).status === "pending_approval") fail("Decide el pedido antes de completar su tarea.");
  const result = d.action === "claim" ? claimTask(t, c.uid, c.actor.displayName, c.now) : d.action === "release" ? releaseTask(t, c.uid, ["owner", "manager"].includes(c.actor.role)) : d.action === "done" ? completeTask(t, c.uid, c.now) : cancelTask(t, c.uid, c.now);
  if (!result.ok) {
    if (result.reason === "taken") return { result: "taken", claimedBy: result.claimedBy, claimedByName: result.claimedByName };
    fail(result.reason === "not_owner" ? "Solo el responsable o un encargado puede soltar esta tarea." : "Esta tarea ya est\xE1 cerrada.");
  }
  if (result.ok) {
    c.put("floorTasks", result.task);
    if (d.action === "done" && t.type === "pickup") {
      destination(c, t.sessionId, t.takeawayId);
      const current = destinationLines(c, t.sessionId, t.takeawayId);
      for (const id2 of t.lineIds) {
        const l = current.find((l2) => l2.id === id2);
        if (l?.status === "ready") lineStatus(c, l, "served");
      }
      reconcile(c);
      if (t.sessionId) for (const l of autoFireAfterServe(destinationLines(c, t.sessionId, null), c.settings)) lineStatus(c, l, "fired");
    }
    return { result: "ok", status: result.task.status, claimedBy: result.task.claimedBy, claimedByName: result.task.claimedByName };
  }
  return fail("No se ha podido cambiar la tarea.");
}

// src/fase2/public.ts
var public_exports = {};
__export(public_exports, {
  avisarDesdeMesa: () => avisarDesdeMesa,
  currentSession: () => currentSession,
  pedirDesdeMesa: () => pedirDesdeMesa,
  publicLines: () => publicLines,
  rateLimit: () => rateLimit,
  tableLink: () => tableLink,
  tokenMatches: () => tokenMatches,
  verMesaPublica: () => verMesaPublica
});
import { timingSafeEqual as timingSafeEqual3 } from "crypto";
import { FieldValue as FieldValue5, Timestamp as Timestamp11 } from "firebase-admin/firestore";
import { HttpsError as HttpsError9 } from "firebase-functions/v2/https";
function tokenMatches(hash2, token2) {
  const actual = sha256Hex(token2);
  return typeof hash2 === "string" && hash2.length === actual.length && timingSafeEqual3(Buffer.from(hash2), Buffer.from(actual));
}
function tableLink(c, d) {
  const table = get(c, "tables", d.tableId);
  if (!table.enabled || !tokenMatches(c.privateRows.tableTokens.get(d.tableId)?.tokenHash, d.token)) throw new HttpsError9("permission-denied", "El enlace de esta mesa no es v\xE1lido.");
  return table;
}
function currentSession(c, tableId, sessionId) {
  const sessions = [...c.rows.tableSessions.values()].filter((s) => sessionIsOpen(s.status) && s.tableIds.includes(tableId));
  if (sessions.length > 1) fail("Hay m\xE1s de una sesi\xF3n en esta mesa. Avisa al encargado.");
  const session = sessions[0] ?? null;
  if (sessionId && session?.id !== sessionId) fail("La mesa ha cambiado. Vuelve a consultarla antes de pedir.");
  return session;
}
function publicLines(lines) {
  const fields = (l) => ({ name: l.name, variant: l.variant?.name ?? null, modifiers: l.modifiers.map((m) => m.name), status: publicLineStatus(l.status) });
  return lines.filter((l) => l.kind !== "menu_component").map((l) => {
    const children = lines.filter((c) => c.parentLineId === l.id);
    return {
      id: l.id,
      kind: l.kind,
      ...fields(l),
      quantity: l.quantity,
      totalCents: l.totalCents + children.filter((c) => c.status !== "cancelled").reduce((n, c) => n + c.totalCents, 0),
      components: children.map(fields)
    };
  });
}
async function rateLimit(tx, rid, request, credential) {
  const keys = [`ip:${request.rawRequest?.ip ?? "local"}`, ...credential ? [`credential:${credential}`] : []];
  const now = Date.now();
  const snapshots = await Promise.all(keys.map((value) => tx.get(db.doc(`restaurants/${rid}/floorRateLimits/${sha256Hex(value)}`))));
  const writes = snapshots.map((snapshot) => {
    const old = snapshot.data(), since = old ? timestampToMillis(old.since) ?? now : now;
    const count = old && now - since < 6e4 ? Number(old.count) : 0;
    if (count >= 60) throw new HttpsError9("resource-exhausted", "Demasiadas solicitudes. Espera un minuto antes de volver a intentarlo.");
    return { snapshot, since: count ? since : now, count: count + 1 };
  });
  for (const { snapshot, since, count } of writes) tx.set(snapshot.ref, {
    since: Timestamp11.fromMillis(since),
    count,
    updatedBy: null,
    updatedAt: FieldValue5.serverTimestamp(),
    ...!snapshot.exists ? { createdAt: FieldValue5.serverTimestamp() } : {}
  });
}
function verMesaPublica(c, d) {
  const table = tableLink(c, d), s = currentSession(c, table.id), enabled = hasModule(c.restaurant, "floor");
  return {
    restaurantName: c.restaurant.name,
    locationName: c.location.name,
    tableName: table.name,
    publicMenuId: publicMenuId(c.rid, c.lid),
    canOrder: enabled && c.settings.selfOrder.enabled && !!s,
    requireApproval: c.settings.selfOrder.requireApproval,
    callWaiter: enabled && c.settings.selfOrder.callWaiter,
    requestBill: enabled && c.settings.selfOrder.requestBill,
    session: s ? { sessionId: s.id, status: s.status, guests: s.guests, totalCents: s.totalCents, lines: publicLines(destinationLines(c, s.id, null)) } : null
  };
}
function pedirDesdeMesa(c, d) {
  requireFloor(c);
  tableLink(c, d);
  const s = currentSession(c, d.tableId, d.sessionId);
  if (!s || !c.settings.selfOrder.enabled) fail("Esta mesa no admite pedidos desde el enlace.");
  const result = placeOrder(c, { sessionId: s.id, takeawayId: null, lines: d.lines, fire: "auto", note: d.note, expectedTotalCents: d.expectedTotalCents, source: "table", language: d.language, pending: c.settings.selfOrder.requireApproval });
  return result.status === "rejected" ? result : { status: c.settings.selfOrder.requireApproval ? "pending_approval" : "sent", orderId: result.orderId, totalCents: result.totalCents };
}
function avisarDesdeMesa(c, d) {
  requireFloor(c);
  const table = tableLink(c, d), s = currentSession(c, table.id, d.sessionId);
  if (d.kind === "request_bill") {
    if (!s || !d.sessionId || !c.settings.selfOrder.requestBill) fail("La cuenta necesita una mesa abierta y el aviso habilitado.");
    if (s.status !== "bill_requested") sessionStatus(c, s, "bill_requested");
    return { ok: true, taskId: billTask(c, get(c, "tableSessions", s.id)).id };
  }
  if (!c.settings.selfOrder.callWaiter) fail("El aviso al camarero est\xE1 desactivado.");
  const t = task(c, { type: "call_waiter", sessionId: s?.id ?? null, takeawayId: null, tableId: table.id, tableIds: s?.tableIds ?? [table.id], label: s?.label ?? table.name });
  return { ok: true, taskId: t.id };
}

// src/fase2/takeaways.ts
var takeaways_exports = {};
__export(takeaways_exports, {
  cambiarEstadoParaLlevar: () => cambiarEstadoParaLlevar,
  consultarRecogida: () => consultarRecogida,
  crearParaLlevar: () => crearParaLlevar,
  createTakeaway: () => createTakeaway,
  pedirParaLlevar: () => pedirParaLlevar,
  verParaLlevarPublico: () => verParaLlevarPublico
});
import { randomBytes as randomBytes5 } from "crypto";
import { HttpsError as HttpsError10 } from "firebase-functions/v2/https";
function slots(c, date, staff = false) {
  const today = horaLocal(c.now, c.reservationSettings.timezone).fecha;
  if (!staff && (date < today || date > sumarDias(today, c.reservationSettings.maxAdvanceDays))) return [];
  const counts = {};
  for (const t of c.rows.takeaways.values()) if (t.status !== "cancelled") counts[t.pickupAt] = (counts[t.pickupAt] ?? 0) + 1;
  return pickupSlots(settingsToConfiguracion(c.reservationSettings), c.settings.takeaway, date, c.now, counts, staff);
}
function consultarRecogida(c, d) {
  const enabled = hasModule(c.restaurant, "floor") && c.settings.takeaway.enabled && c.settings.takeaway.publicOrdering;
  return { date: d.date, timezone: c.reservationSettings.timezone, enabled, slots: enabled ? slots(c, d.date) : [] };
}
function createTakeaway(c, d, staff) {
  requireFloor(c);
  if (!c.settings.takeaway.enabled || !staff && !c.settings.takeaway.publicOrdering) fail("Los pedidos para llevar est\xE1n desactivados.");
  const slot = findPickupSlot(slots(c, d.date, staff), d.time);
  if (!slot) fail("La hora de recogida ya no est\xE1 disponible.");
  const catalog = staff ? { items: Object.fromEntries(c.rows.menuItems), dailyMenus: Object.fromEntries(c.rows.dailyMenus) } : publicMenuCatalog(publicMenu(c));
  const priced = priceOrder(d.lines, catalog, { channel: "takeaway", now: slot.startAt, timezone: c.reservationSettings.timezone, expectedTotalCents: "expectedTotalCents" in d ? d.expectedTotalCents : null });
  if (!priced.ok) return { status: "rejected", problems: priced.problems, totalCents: priced.totalCents };
  const slotKey = sha256Hex(JSON.stringify(["takeaway", slot.startAt]));
  const oldLock = c.privateRows.serviceLocks.get(slotKey);
  c.secret("serviceLocks", slotKey, { revision: Number(oldLock?.revision ?? 0) + 1 });
  const reference = reservationReference(randomBytes5(16)), manageToken = linkToken(randomBytes5(32));
  if (c.takeawayReferences.has(reference)) throw new HttpsError10("aborted", "Repite la operaci\xF3n para obtener otra referencia.");
  const takeawayId = newId(c, "takeaways"), status = staff || c.settings.takeaway.autoAccept ? "accepted" : "pending";
  const t = {
    id: takeawayId,
    guestName: d.guestName,
    phone: d.phone,
    email: d.email,
    language: d.language,
    customerId: customer(c, d.guestName, d.phone, d.email, d.language),
    pickupAt: slot.startAt,
    status,
    reference,
    manageTokenHash: sha256Hex(manageToken),
    source: "source" in d ? d.source : "web",
    notes: d.notes,
    totalCents: priced.totalCents,
    orderIds: [],
    readyAt: null,
    pickedUpAt: null,
    cancelReason: null,
    history: [],
    createdBy: c.uid
  };
  c.put("takeaways", t, true);
  c.takeawayReferences.set(reference, { locationId: c.lid, takeawayId });
  c.stage(`${c.root.path}/takeawayReferences/${reference}`, { locationId: c.lid, takeawayId }, true);
  const result = placeOrder(c, {
    sessionId: null,
    takeawayId,
    lines: d.lines,
    fire: "fire" in d ? d.fire : "auto",
    note: "",
    expectedTotalCents: priced.totalCents,
    source: staff ? "staff" : "takeaway_web",
    language: d.language,
    pending: status === "pending"
  });
  if (result.status === "rejected") fail("La carta ha cambiado. Revisa el pedido.");
  return { status, takeawayId, orderId: result.status === "sent" ? result.orderId : "", reference, manageToken, pickupAt: slot.startAt, totalCents: priced.totalCents };
}
function crearParaLlevar(c, d) {
  return createTakeaway(c, d, true);
}
function pedirParaLlevar(c, d) {
  return createTakeaway(c, d, false);
}
function verParaLlevarPublico(c, d) {
  requireFloor(c);
  const ref = c.takeawayReferences.get(d.reference);
  const t = ref?.locationId === c.lid ? c.rows.takeaways.get(ref.takeawayId) : void 0;
  if (!t || !tokenMatches(t.manageTokenHash, d.token)) throw new HttpsError10("permission-denied", "El enlace de seguimiento no es v\xE1lido.");
  return {
    reference: t.reference,
    status: t.status,
    guestName: t.guestName,
    pickupAt: t.pickupAt,
    timezone: c.reservationSettings.timezone,
    locationName: c.location.name,
    totalCents: t.totalCents,
    lines: publicLines(destinationLines(c, null, t.id))
  };
}
function cambiarEstadoParaLlevar(c, d) {
  const t = get(c, "takeaways", d.takeawayId);
  if (t.status === d.status) return { ok: true, status: t.status };
  if (!canTakeawayTransition(t.status, d.status)) fail("El pedido no admite ese cambio de estado.");
  const lines = destinationLines(c, null, t.id).filter((l) => l.kind !== "menu");
  if (d.status === "accepted" && t.status === "pending") {
    for (const id2 of t.orderIds) if (get(c, "orders", id2).status === "pending_approval") decide(c, id2, "accept", null, "auto");
  } else if (d.status === "accepted" && t.status === "ready") {
    fail("Deshaz el estado de los platos para volver a preparaci\xF3n.");
  } else if (d.status === "ready" || d.status === "picked_up") {
    if (!lines.length || lines.filter((l) => l.status !== "cancelled").some((l) => l.status !== "ready" && l.status !== "served")) fail("Todav\xEDa quedan platos por preparar.");
    if (d.status === "picked_up") {
      for (const l of lines) if (l.status === "ready") lineStatus(c, l, "served");
    }
  } else if (d.status === "cancelled") {
    if (!d.reason?.trim()) fail("Indica el motivo de la cancelaci\xF3n.");
    for (const l of lines) if (l.status !== "cancelled" && l.status !== "pending") checkLine(c, l, "cancelled", d.reason);
    for (const l of lines) if (l.status !== "cancelled") lineStatus(c, l, "cancelled", d.reason);
    for (const id2 of t.orderIds) {
      const o = get(c, "orders", id2);
      if (o.status === "pending_approval") c.put("orders", { ...o, status: "rejected", decidedAt: c.now, decidedBy: c.uid, rejectReason: d.reason ?? null });
    }
  }
  takeawayStatus(c, t, d.status, d.reason ?? null);
  if (d.status === "picked_up" || d.status === "cancelled") {
    for (const task2 of c.rows.floorTasks.values()) if (task2.takeawayId === t.id) closeTask(c, task2, "cancelled");
  }
  return { ok: true, status: d.status };
}

// src/fase2/index.ts
var handlers = { ...catalog_exports, ...sessions_exports, ...orders_exports, ...tasks_exports, ...public_exports, ...takeaways_exports };
var actions = {
  guardarCategoriaCarta: ["menu.categorySaved", "Categor\xEDa de carta guardada."],
  guardarPlato: ["menu.itemSaved", "Plato de carta guardado."],
  guardarMenuDia: ["menu.dailyMenuSaved", "Men\xFA del d\xEDa guardado."],
  ordenarCarta: ["menu.sorted", "Carta ordenada."],
  marcarAgotado: ["menu.soldOutChanged", "Agotados de carta actualizados."],
  guardarEstacion: ["station.saved", "Estaci\xF3n guardada."],
  guardarConfiguracionSala: ["floor.settingsChanged", "Configuraci\xF3n de sala guardada."],
  regenerarQrMesa: ["table.qrRotated", "Enlaces de mesa renovados."],
  abrirMesa: ["tableSession.opened", "Mesa abierta."],
  cambiarEstadoMesa: ["tableSession.statusChanged", "Estado de mesa actualizado."],
  editarMesa: ["tableSession.edited", "Mesa actualizada."],
  moverMesa: ["tableSession.moved", "Mesa movida."],
  juntarMesas: ["tableSession.merged", "Mesas juntadas."],
  separarMesas: ["tableSession.split", "Mesas separadas."],
  enviarPedido: ["order.placed", "Pedido enviado."],
  decidirPedido: ["order.decided", "Pedido decidido."],
  marcharPase: ["orderLine.statusChanged", "Pase marchado."],
  cambiarEstadoLineas: ["orderLine.statusChanged", "Estado de platos actualizado."],
  crearTarea: ["floorTask.created", "Tarea de sala creada."],
  cambiarEstadoTarea: ["floorTask.completed", "Tarea de sala actualizada."],
  verMesaPublica: ["table.viewed", "Mesa consultada."],
  pedirDesdeMesa: ["order.placed", "Pedido recibido desde la mesa."],
  avisarDesdeMesa: ["floorTask.created", "Aviso recibido desde la mesa."],
  consultarRecogida: ["takeaway.slotsViewed", "Horas de recogida consultadas."],
  pedirParaLlevar: ["takeaway.created", "Pedido para llevar recibido."],
  verParaLlevarPublico: ["takeaway.viewed", "Recogida consultada."],
  crearParaLlevar: ["takeaway.created", "Pedido para llevar creado."],
  cambiarEstadoParaLlevar: ["takeaway.statusChanged", "Estado de recogida actualizado."]
};
async function execute(name, data, request) {
  const schema = CALLABLE_SCHEMAS_FASE2[name];
  const d = parse(schema.input, data);
  const input = d;
  const isPublic = FASE2_ACCESS[name].permission === "public";
  if (isPublic) await db.runTransaction(async (tx) => {
    const rid = await resolveRestaurant(tx, input.slug);
    await rateLimit(tx, rid, request, input.token ?? input.phone ?? null);
  });
  return db.runTransaction(async (tx) => {
    const rid = isPublic ? await resolveRestaurant(tx, input.slug) : input.restaurantId;
    let lid = input.locationId;
    if (name === "verParaLlevarPublico") {
      const ref = (await tx.get(db.doc(`restaurants/${rid}/takeawayReferences/${input.reference}`))).data();
      if (!ref) throw new HttpsError11("permission-denied", "El enlace de seguimiento no es v\xE1lido.");
      lid = ref.locationId;
    }
    const c = await context(tx, rid, lid, isPublic ? void 0 : request, name);
    const handle = handlers[name];
    const result = schema.output.parse(await handle(c, d));
    if (!("status" in result && result.status === "rejected") && !["verMesaPublica", "consultarRecogida", "verParaLlevarPublico"].includes(name)) reconcile(c);
    const action = name === "cambiarEstadoTarea" && d.action === "claim" ? "floorTask.claimed" : actions[name][0];
    c.flush(["verMesaPublica", "consultarRecogida", "verParaLlevarPublico"].includes(name) || "status" in result && result.status === "rejected" ? null : action, actions[name][1]);
    return result;
  });
}
function callable2(name) {
  return onCall9(options, (request) => safe(() => execute(name, request.data, request)));
}
var guardarCategoriaCarta2 = callable2("guardarCategoriaCarta");
var guardarPlato2 = callable2("guardarPlato");
var guardarMenuDia2 = callable2("guardarMenuDia");
var ordenarCarta2 = callable2("ordenarCarta");
var marcarAgotado2 = callable2("marcarAgotado");
var guardarEstacion2 = callable2("guardarEstacion");
var guardarConfiguracionSala2 = callable2("guardarConfiguracionSala");
var regenerarQrMesa2 = callable2("regenerarQrMesa");
var abrirMesa2 = callable2("abrirMesa");
var cambiarEstadoMesa2 = callable2("cambiarEstadoMesa");
var editarMesa2 = callable2("editarMesa");
var moverMesa2 = callable2("moverMesa");
var juntarMesas2 = callable2("juntarMesas");
var separarMesas2 = callable2("separarMesas");
var enviarPedido2 = callable2("enviarPedido");
var decidirPedido2 = callable2("decidirPedido");
var marcharPase2 = callable2("marcharPase");
var cambiarEstadoLineas2 = callable2("cambiarEstadoLineas");
var crearTarea2 = callable2("crearTarea");
var cambiarEstadoTarea2 = callable2("cambiarEstadoTarea");
var verMesaPublica2 = callable2("verMesaPublica");
var pedirDesdeMesa2 = callable2("pedirDesdeMesa");
var avisarDesdeMesa2 = callable2("avisarDesdeMesa");
var consultarRecogida2 = callable2("consultarRecogida");
var pedirParaLlevar2 = callable2("pedirParaLlevar");
var verParaLlevarPublico2 = callable2("verParaLlevarPublico");
var crearParaLlevar2 = callable2("crearParaLlevar");
var cambiarEstadoParaLlevar2 = callable2("cambiarEstadoParaLlevar");

// src/fase2/process.ts
import { onSchedule as onSchedule2 } from "firebase-functions/v2/scheduler";
async function processTakeaways(rid, lid) {
  const restaurants = rid ? [db.doc(`restaurants/${rid}`)] : (await db.collection("restaurants").get()).docs.map((d) => d.ref);
  let fired = 0;
  for (const root of restaurants) {
    const locations = lid ? [root.collection("locations").doc(lid)] : (await root.collection("locations").get()).docs.map((d) => d.ref);
    for (const local of locations) {
      fired += await db.runTransaction(async (tx) => {
        const c = await context(tx, root.id, local.id);
        if (!hasModule(c.restaurant, "floor")) return 0;
        let count = 0;
        for (const take of c.rows.takeaways.values()) {
          if (take.status !== "accepted") continue;
          for (const line of dueTakeawayLines(destinationLines(c, null, take.id), c.now)) {
            lineStatus(c, line, "fired");
            count++;
          }
        }
        if (count) {
          reconcile(c);
          c.flush("orderLine.statusChanged", "Platos para llevar marchados a su hora.");
        }
        return count;
      });
    }
  }
  return { fired };
}
var marcharParaLlevar = onSchedule2({ ...options, schedule: "every 1 minutes", timeZone: "Europe/Madrid" }, () => processTakeaways().then(() => void 0));

// src/fase2/triggers.ts
import { isDeepStrictEqual } from "util";
import { onDocumentWritten as onDocumentWritten2 } from "firebase-functions/v2/firestore";
import { FieldValue as FieldValue6 } from "firebase-admin/firestore";
async function syncPublicMenu(rid, lid) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection("locations").doc(lid);
  const projection = db.doc(`publicMenus/${publicMenuId(rid, lid)}`);
  await db.runTransaction(async (tx) => {
    const lock2 = local.collection("serviceLocks").doc("publication");
    const [r, l, lockDoc, floor, settings2, previous] = await Promise.all([tx.get(root), tx.get(local), tx.get(lock2), tx.get(local.collection("settings").doc("floor")), tx.get(local.collection("settings").doc("reservations")), tx.get(projection)]);
    if (!r.exists || !l.exists) {
      tx.delete(projection);
      return;
    }
    const [categories, items, menus] = await Promise.all(["menuCategories", "menuItems", "dailyMenus"].map((name) => tx.get(local.collection(name))));
    const data = buildPublicMenu({
      restaurantId: rid,
      locationId: lid,
      restaurantName: r.get("name"),
      locationName: l.get("name"),
      brandColor: r.get("brandColor"),
      timezone: settings2.exists ? ReservationSettingsSchema.parse(settings2.data()).timezone : r.get("timezone"),
      categories: Object.fromEntries(categories.docs.map((d) => [d.id, MenuCategorySchema.parse(d.data())])),
      items: Object.fromEntries(items.docs.map((d) => [d.id, MenuItemSchema.parse(d.data())])),
      dailyMenus: Object.fromEntries(menus.docs.map((d) => [d.id, DailyMenuSchema.parse(d.data())])),
      settings: floor.exists ? FloorSettingsSchema.parse(floor.data()) : defaultFloorSettings(),
      floorModule: hasModule(r.data(), "floor")
    });
    if (previous.exists && isDeepStrictEqual(PublicMenuSchema.parse(previous.data()), data)) return;
    tx.set(lock2, { revision: Number(lockDoc.get("revision") ?? 0) + 1, updatedAt: FieldValue6.serverTimestamp() }, { merge: true });
    tx.set(projection, { ...PublicMenuSchema.parse(data), createdAt: previous.get("createdAt") ?? FieldValue6.serverTimestamp(), updatedAt: FieldValue6.serverTimestamp() });
  });
}
var cartaPublica = onDocumentWritten2({ ...options, document: "restaurants/{rid}/locations/{lid}/{collection}/{id}" }, (event) => {
  if (["menuCategories", "menuItems", "dailyMenus"].includes(event.params.collection) || event.params.collection === "settings" && ["floor", "reservations"].includes(event.params.id)) return syncPublicMenu(event.params.rid, event.params.lid);
  return void 0;
});
var cartaLocal = onDocumentWritten2({ ...options, document: "restaurants/{rid}/locations/{lid}" }, (event) => syncPublicMenu(event.params.rid, event.params.lid));
var cartaRestaurante = onDocumentWritten2({ ...options, document: "restaurants/{rid}" }, async (event) => {
  const before = event.data?.before.data(), after = event.data?.after.data();
  if (before && after && ["name", "brandColor", "timezone", "plan", "moduleOverrides", "activeModules"].every((k) => isDeepStrictEqual(before[k], after[k]))) return;
  const locals = await db.collection(`restaurants/${event.params.rid}/locations`).get();
  for (const l of locals.docs) await syncPublicMenu(event.params.rid, l.id);
});
var serviceCollections = ["tableSessions", "orders", "orderLines", "floorTasks", "takeaways", "menuCategories", "menuItems", "dailyMenus", "stations", "settings", "tableTokens"];
var actividadSala = onDocumentWritten2({ ...options, document: "restaurants/{rid}/locations/{lid}/{collection}/{id}" }, async (event) => {
  if (!serviceCollections.includes(event.params.collection) || event.params.collection === "settings" && event.params.id !== "floor" || !event.data) return;
  const before = event.data.before.data(), after = event.data.after.data(), data = after ?? before;
  if (!data || after?.changeId && after.changeId !== before?.changeId) return;
  const clean = (d) => Object.fromEntries(Object.entries(d ?? {}).filter(([key]) => !["updatedAt", "createdAt", "updatedBy", "changeId"].includes(key)));
  if (isDeepStrictEqual(clean(before), clean(after))) return;
  const root = db.doc(`restaurants/${event.params.rid}`), ref = root.collection("activity").doc(sha256Hex(event.id));
  await db.runTransaction(async (tx) => {
    const previous = await tx.get(ref);
    if (previous.exists) return;
    const uid = typeof data.updatedBy === "string" ? data.updatedBy : null;
    const actor = uid ? await tx.get(db.doc(`users/${uid}`)) : null;
    tx.create(ref, {
      action: `${event.params.collection}.changed`,
      summary: "Datos del servicio actualizados.",
      actorUid: uid,
      actorName: actor?.get("displayName") ?? null,
      entity: { type: event.params.collection, id: event.params.id },
      createdAt: FieldValue6.serverTimestamp(),
      updatedAt: FieldValue6.serverTimestamp()
    });
  });
});
async function reconcileLocation(rid, lid) {
  await db.runTransaction(async (tx) => {
    const [restaurant, local] = await Promise.all([tx.get(db.doc(`restaurants/${rid}`)), tx.get(db.doc(`restaurants/${rid}/locations/${lid}`))]);
    if (!restaurant.exists || !local.exists) return;
    const c = await context(tx, rid, lid);
    reconcile(c);
    c.flush("floor.reconciled", "Consumo y tareas del servicio revisados.");
  });
}
var reconciliarSala = onDocumentWritten2({ ...options, document: "restaurants/{rid}/locations/{lid}/{collection}/{id}" }, (event) => {
  if (["tableSessions", "takeaways", "orderLines", "stations"].includes(event.params.collection)) return reconcileLocation(event.params.rid, event.params.lid);
  return void 0;
});

// src/fase3/index.ts
import { onCall as onCall10, HttpsError as HttpsError13 } from "firebase-functions/v2/https";

// src/fase3/context.ts
import { FieldValue as FieldValue7, Timestamp as Timestamp12 } from "firebase-admin/firestore";
import { HttpsError as HttpsError12 } from "firebase-functions/v2/https";
var names = ["guardarConfiguracionCaja", "abrirCaja", "cerrarCaja", "registrarMovimientoCaja", "abrirCuenta", "verCuenta", "ajustarCuenta", "dividirCuenta", "prepararCobro", "desbloquearCuenta", "registrarCobro", "devolverCobro", "emitirFactura", "rectificarFactura", "sustituirSimplificada", "anularRegistroFiscal", "repartirPropinas"];
function fail2(message) {
  throw new HttpsError12("failed-precondition", message);
}
var hash = (v) => sha256Hex(JSON.stringify(v));
function localOnly() {
  if (process.env.GCLOUD_PROJECT !== "demo-llenamos" || !process.env.FIRESTORE_EMULATOR_HOST) fail2("El proveedor de prueba solo funciona en los emuladores de demo. No es v\xE1lido para Hacienda.");
}
var schemas2 = {
  bills: BillSchema,
  billParts: BillPartSchema,
  payments: PaymentSchema,
  cashSessions: CashSessionSchema,
  cashMovements: CashMovementSchema,
  invoices: InvoiceSchema,
  invoiceSeries: InvoiceSeriesSchema,
  tableSessions: TableSessionSchema,
  takeaways: TakeawaySchema,
  orderLines: OrderLineSchema,
  reservations: ReservationSchema,
  paymentReservations: PaymentReservationSchema,
  mobileCheckouts: MobileCheckoutSchema,
  tipDistributions: TipDistributionSchema
};
var privateNames = ["billTargets", "registerLocks", "depositApplications", "paymentEvents", "invoiceEvents"];
async function context3(tx, rid, lid, name, request) {
  const root = db.doc(`restaurants/${rid}`), local = root.collection("locations").doc(lid);
  const [r, l, lock2, config] = await Promise.all([tx.get(root), tx.get(local), tx.get(local.collection("reservationLocks").doc("current")), tx.get(local.collection("settings").doc("pos"))]);
  if (!r.exists || !l.exists) throw new HttpsError12("not-found", "No se encuentra el restaurante o el local.");
  const actor = request ? await membership(tx, rid, uidOf(request)) : null;
  const access = FASE3_ACCESS[name];
  if (request && (!actor?.active || actor.locationIds.length && !actor.locationIds.includes(lid) || !can(actor.role, access.permission))) throw new HttpsError12("permission-denied", "No tienes permiso para esta operaci\xF3n en este local.");
  if (request && access.modules.some((m) => !hasModule(r.data(), m))) fail2("El m\xF3dulo necesario est\xE1 desactivado.");
  const rows = {};
  const checkoutMetadata = /* @__PURE__ */ new Map();
  await Promise.all(Object.entries(schemas2).map(async ([key, schema]) => {
    const snap = await tx.get(local.collection(key));
    if (key === "mobileCheckouts") for (const doc of snap.docs) checkoutMetadata.set(doc.id, doc.data());
    Object.assign(rows, { [key]: new Map(snap.docs.map((doc) => [doc.id, schema.parse(doc.data())])) });
  }));
  const secrets = {};
  await Promise.all(privateNames.map(async (key) => {
    secrets[key] = new Map((await tx.get(local.collection(key))).docs.map((d) => [d.id, d.data()]));
  }));
  const members = new Map((await tx.get(root.collection("members"))).docs.map((d) => [d.id, MemberSchema.parse(d.data())]));
  const writes = /* @__PURE__ */ new Map();
  const now = Date.now(), uid = actor?.uid ?? null;
  function stage(path, data, create2 = false) {
    const previous = writes.get(path);
    writes.set(path, { data: { ...previous?.data, ...data }, create: previous?.create ?? create2 });
  }
  function put(key, id2, data) {
    const fresh = !rows[key].has(id2);
    const parsed = schemas2[key].parse(data);
    rows[key].set(id2, parsed);
    stage(`${local.path}/${key}/${id2}`, parsed, fresh);
  }
  function secret(key, id2, data) {
    stage(`${local.path}/${key}/${id2}`, data, !secrets[key].has(id2));
    secrets[key].set(id2, data);
  }
  function remove(key, id2) {
    rows[key].delete(id2);
    writes.set(`${local.path}/${key}/${id2}`, { data: {}, create: false, remove: true });
  }
  function flush(action, summary, details = {}) {
    const conversions = {
      bills: billForWrite,
      payments: paymentForWrite,
      cashSessions: cashSessionForWrite,
      cashMovements: cashMovementForWrite,
      tipDistributions: tipDistributionForWrite,
      paymentReservations: paymentReservationForWrite,
      mobileCheckouts: mobileCheckoutForWrite,
      printRequests: printRequestForWrite,
      fiscalOutbox: fiscalOutboxForWrite
    };
    for (const [path, w] of writes) {
      if (w.remove) {
        tx.delete(db.doc(path));
        continue;
      }
      const convert = conversions[path.split("/").at(-2)];
      const data = convert ? convert(w.data, Timestamp12.fromMillis) : w.data;
      const value = { ...data, updatedBy: uid, updatedAt: FieldValue7.serverTimestamp(), ...w.create ? { createdAt: FieldValue7.serverTimestamp() } : {} };
      if (Buffer.byteLength(JSON.stringify(value)) > 9e5) fail2("El documento supera el tama\xF1o permitido. Divide la cuenta.");
      if (w.create) tx.create(db.doc(path), value);
      else tx.set(db.doc(path), value, { merge: true });
    }
    if (writes.size) tx.set(lock2.ref, { revision: FieldValue7.increment(1) }, { merge: true });
    if (action) tx.create(root.collection("activity").doc(), { action, summary, actorUid: uid, actorName: actor?.displayName ?? null, entity: { type: "location", id: lid }, details, createdAt: FieldValue7.serverTimestamp(), updatedAt: FieldValue7.serverTimestamp() });
  }
  return {
    tx,
    root,
    local,
    rid,
    lid,
    restaurant: r.data(),
    location: l.data(),
    actor,
    uid,
    now,
    rows,
    secrets,
    members,
    writes,
    stage,
    put,
    secret,
    remove,
    flush,
    checkoutMetadata,
    settings: config.exists ? PosSettingsSchema.parse(config.data()) : null
  };
}
function get2(c, key, id2) {
  const row = c.rows[key].get(id2);
  if (!row) throw new HttpsError12("not-found", "No se encuentra el documento en este local.");
  return row;
}
var newId2 = (c, key) => c.local.collection(key).doc().id;
function account(c, d) {
  const bill = get2(c, "bills", d.billId);
  if (bill.revision !== d.expectedRevision) fail2("La cuenta ha cambiado. Recarga antes de continuar.");
  return bill;
}
var parts = (c, billId) => [...c.rows.billParts].filter(([, p]) => p.billId === billId).map(([id2, p]) => ({ ...p, id: id2 }));
function cashOpen(c, id2) {
  const cash = get2(c, "cashSessions", id2);
  if (cash.status !== "open" || c.secrets.registerLocks.get(cash.registerId)?.cashSessionId !== id2) fail2("Abre una caja antes de registrar el movimiento.");
  return cash;
}

// src/fase3/accounts.ts
var accounts_exports = {};
__export(accounts_exports, {
  abrirCuenta: () => abrirCuenta,
  ajustarCuenta: () => ajustarCuenta,
  desbloquearCuenta: () => desbloquearCuenta,
  dividirCuenta: () => dividirCuenta,
  prepararCobro: () => prepararCobro,
  refresh: () => refresh,
  replaceParts: () => replaceParts,
  source: () => source,
  verCuenta: () => verCuenta
});
function source(c, target) {
  const dest = target.kind === "session" ? get2(c, "tableSessions", target.id) : get2(c, "takeaways", target.id);
  if ("mergedInto" in dest && dest.mergedInto) fail2("Esta sesi\xF3n se ha juntado con otra mesa. Abre la cuenta de destino.");
  const lines = [...c.rows.orderLines].filter(([, l]) => target.kind === "session" ? l.sessionId === target.id : l.takeawayId === target.id).map(([id2, l]) => ({ ...l, id: id2 }));
  return { customerId: dest.customerId, lines: billLinesFromOrderLines(lines) };
}
function refresh(c, billId) {
  const bill = get2(c, "bills", billId);
  if (bill.status !== "open") return false;
  const current = source(c, bill.target);
  if (JSON.stringify(current.lines) === JSON.stringify(bill.lines) && current.customerId === bill.customerId) return false;
  const net = netBillLines(current.lines, bill.adjustments);
  const next = { ...bill, ...current, revision: bill.revision + 1, totalCents: sumCents(net.map((l) => l.grossCents)) };
  c.put("bills", billId, next);
  replaceParts(c, billId, next, { kind: "equal", parts: 1 });
  return true;
}
function replaceParts(c, billId, bill, split) {
  const plans = splitBill(netBillLines(bill.lines, bill.adjustments), split);
  for (const p of parts(c, billId)) {
    if (p.paidCents || p.invoiceId || c.rows.paymentReservations.has(p.id)) fail2("La cuenta ya tiene cobros, facturas o pagos en curso.");
    c.remove("billParts", p.id);
  }
  return plans.map((plan2, i) => {
    const id2 = newId2(c, "billParts"), part = { ...plan2, billId, label: plans.length === 1 ? "Cuenta completa" : `Parte ${i + 1}`, revision: bill.revision, paidCents: 0, invoiceId: null };
    c.put("billParts", id2, part);
    return { ...part, id: id2 };
  });
}
function abrirCuenta(c, d) {
  const key = hash([d.target.kind, d.target.id]), old = c.secrets.billTargets.get(key);
  if (old) {
    refresh(c, old.billId);
    return { billId: old.billId, bill: get2(c, "bills", old.billId) };
  }
  const current = source(c, d.target);
  if (!current.lines.length) fail2("El destino no tiene consumo para abrir una cuenta.");
  const id2 = newId2(c, "bills"), bill = { ...current, target: d.target, status: "open", revision: 1, adjustments: [], totalCents: sumCents(current.lines.map((l) => l.grossCents)), paidCents: 0, refundedCents: 0, openedAt: c.now, lockedAt: null, settledAt: null };
  c.put("bills", id2, bill);
  c.secret("billTargets", key, { billId: id2 });
  replaceParts(c, id2, bill, { kind: "equal", parts: 1 });
  return { billId: id2, bill };
}
function verCuenta(c, d) {
  refresh(c, d.billId);
  return { bill: get2(c, "bills", d.billId), parts: parts(c, d.billId) };
}
function ajustarCuenta(c, d) {
  const bill = account(c, d);
  if (bill.status !== "open") fail2("Desbloquea la cuenta antes de ajustar el consumo.");
  const adjustment = { id: newId2(c, "billAdjustments"), lineId: d.lineId, kind: d.kind, amountCents: d.amountCents, reason: d.reason, at: c.now, by: c.uid };
  const adjustments = [...bill.adjustments, adjustment], net = netBillLines(bill.lines, adjustments);
  const next = { ...bill, adjustments, revision: bill.revision + 1, totalCents: sumCents(net.map((l) => l.grossCents)) };
  c.put("bills", d.billId, next);
  replaceParts(c, d.billId, next, { kind: "equal", parts: 1 });
  c.stage(`${c.local.path}/billAdjustments/${adjustment.id}`, { ...adjustment, at: new Date(c.now), billId: d.billId }, true);
  return { ok: true, revision: next.revision, totalCents: next.totalCents };
}
function dividirCuenta(c, d) {
  const bill = account(c, d);
  if (bill.status !== "open") fail2("La cuenta ya est\xE1 bloqueada para el cobro.");
  const next = { ...bill, revision: bill.revision + 1 };
  const result = replaceParts(c, d.billId, next, d.split);
  c.put("bills", d.billId, next);
  return { revision: next.revision, parts: result };
}
function prepararCobro(c, d) {
  const bill = account(c, d);
  if (bill.status !== "open") fail2("La cuenta ya est\xE1 bloqueada o saldada.");
  const next = { ...bill, status: bill.totalCents === 0 ? "settled" : "locked", revision: bill.revision + 1, lockedAt: c.now, settledAt: bill.totalCents === 0 ? c.now : null };
  c.put("bills", d.billId, next);
  for (const p of parts(c, d.billId)) c.put("billParts", p.id, { ...p, revision: next.revision });
  return { ok: true, revision: next.revision };
}
function desbloquearCuenta(c, d) {
  const bill = account(c, d), own = parts(c, d.billId);
  if (bill.status !== "locked" || bill.paidCents || own.some((p) => p.invoiceId || c.rows.paymentReservations.has(p.id)) || [...c.rows.payments.values()].some((p) => p.billId === d.billId && p.status === "pending")) fail2("Solo se desbloquea una cuenta sin cobros, facturas ni reservas de pago.");
  const next = { ...bill, status: "open", revision: bill.revision + 1, lockedAt: null };
  c.put("bills", d.billId, next);
  for (const p of own) c.put("billParts", p.id, { ...p, revision: next.revision });
  return { ok: true, revision: next.revision };
}

// src/fase3/cash.ts
var cash_exports = {};
__export(cash_exports, {
  abrirCaja: () => abrirCaja,
  cerrarCaja: () => cerrarCaja,
  registrarMovimientoCaja: () => registrarMovimientoCaja,
  repartirPropinas: () => repartirPropinas
});
function abrirCaja(c, d) {
  if (c.secrets.registerLocks.get(d.registerId)?.cashSessionId) fail2("Esta caja ya est\xE1 abierta.");
  const cashSessionId = newId2(c, "cashSessions");
  c.put("cashSessions", cashSessionId, { registerId: d.registerId, status: "open", openingCents: d.openingCents, openedAt: c.now, openedBy: c.uid, closedAt: null, closedBy: null, countedCents: null, expectedCents: null, differenceCents: null, closeReason: null });
  c.secret("registerLocks", d.registerId, { cashSessionId });
  return { cashSessionId };
}
function cerrarCaja(c, d) {
  const cash = cashOpen(c, d.cashSessionId);
  const pendingExternal = [...c.checkoutMetadata.values()].some((p) => p.cashSessionId === d.cashSessionId && ["pending", "reconciliation_required"].includes(p.status));
  const reserved = [...c.rows.paymentReservations.values()].some((r) => !r.checkoutId || c.checkoutMetadata.get(r.checkoutId)?.cashSessionId === d.cashSessionId);
  if (pendingExternal || reserved || [...c.rows.payments.values()].some((p) => p.cashSessionId === d.cashSessionId && p.status === "pending")) fail2("Hay pagos externos pendientes. Reconc\xEDlialos antes de cerrar.");
  const payments = [...c.rows.payments.values()].filter((p) => p.cashSessionId === d.cashSessionId);
  const movements = [...c.rows.cashMovements.values()].filter((p) => p.cashSessionId === d.cashSessionId);
  const totals = cashReconciliation(cash.openingCents, payments, movements, d.countedCents);
  if (totals.differenceCents && !d.reason) fail2("Indica el motivo de la diferencia de caja.");
  const result = { ...cash, ...totals, status: "closed", closedAt: c.now, closedBy: c.uid, closeReason: d.reason };
  c.put("cashSessions", d.cashSessionId, result);
  c.secret("registerLocks", cash.registerId, { cashSessionId: null });
  return { ok: true, cashSession: result };
}
function registrarMovimientoCaja(c, d) {
  cashOpen(c, d.cashSessionId);
  const movementId = newId2(c, "cashMovements");
  c.put("cashMovements", movementId, { cashSessionId: d.cashSessionId, kind: d.kind, amountCents: d.amountCents, reason: d.reason, at: c.now, by: c.uid, requestId: d.requestId, distributionId: null });
  return { movementId };
}
function repartirPropinas(c, d) {
  const cash = get2(c, "cashSessions", d.cashSessionId);
  if (cash.status !== "closed") fail2("Cierra y arquea la caja antes de repartir las propinas.");
  if ([...c.rows.tipDistributions.values()].some((t) => t.cashSessionId === d.cashSessionId)) fail2("Las propinas de esta caja ya est\xE1n repartidas.");
  for (const h of d.hours) {
    const member = c.members.get(h.uid);
    if (!member?.active || member.locationIds.length && !member.locationIds.includes(c.lid)) fail2("Las horas deben pertenecer a personal activo de este local.");
  }
  const totalCents = sumCents([...c.rows.payments.values()].filter((p) => p.cashSessionId === d.cashSessionId && p.status === "succeeded").map((p) => (p.kind === "charge" ? 1 : -1) * p.tipCents));
  const shares = distributeTips(totalCents, d.hours), distributionId = newId2(c, "tipDistributions");
  c.put("tipDistributions", distributionId, { cashSessionId: d.cashSessionId, totalCents, shares, at: c.now, by: c.uid });
  return { distributionId, shares };
}

// src/fase3/payments.ts
var payments_exports = {};
__export(payments_exports, {
  devolverCobro: () => devolverCobro,
  externalCharge: () => externalCharge,
  registrarCobro: () => registrarCobro
});
function applyCharge(c, d, method, externalId, tenderedCents = 0, reservationCheckout = null) {
  const bill = account(c, d), part = get2(c, "billParts", d.partId);
  if (bill.status !== "locked" || part.billId !== d.billId || part.revision !== bill.revision) fail2("La parte no pertenece a esta cuenta bloqueada y revisi\xF3n.");
  cashOpen(c, d.cashSessionId);
  const reservation = c.rows.paymentReservations.get(d.partId);
  const own = !!reservation && reservation.checkoutId === reservationCheckout && reservationCheckout !== null;
  if (reservationCheckout && (!own || reservation.billId !== d.billId || reservation.revision !== bill.revision || reservation.amountCents !== d.amountCents)) fail2("La reserva del pago no coincide con la cuenta.");
  checkCharge(part.totalCents, part.paidCents, own ? 0 : reservation?.amountCents ?? 0, d.amountCents);
  const changeCents = method === "cash" ? cashChange(d.amountCents, d.tipCents, tenderedCents) : 0;
  const paymentId = newId2(c, "payments");
  c.put("payments", paymentId, { billId: d.billId, partId: d.partId, cashSessionId: d.cashSessionId, kind: "charge", originalPaymentId: null, method, status: "succeeded", amountCents: d.amountCents, tipCents: d.tipCents, tenderedCents, changeCents, externalId, requestId: d.requestId, reason: null, at: c.now, by: c.uid });
  c.put("billParts", d.partId, { ...part, paidCents: sumCents([part.paidCents, d.amountCents]) });
  const paidCents = sumCents([bill.paidCents, d.amountCents]), settled = paidCents === bill.totalCents;
  if (own) c.remove("paymentReservations", d.partId);
  const pending = [...c.rows.paymentReservations.values()].some((r) => r.billId === d.billId) || [...c.rows.payments.values()].some((p) => p.billId === d.billId && p.status === "pending");
  c.put("bills", d.billId, { ...bill, paidCents, status: settled && !pending ? "settled" : "locked", settledAt: settled && !pending ? c.now : null });
  if (method === "cash") c.stage(`${c.local.path}/printRequests/${hash(["drawer", paymentId])}`, printRequestForWrite({ kind: "drawer", sourceId: paymentId, printerId: null, copy: 0, status: "queued", requestedBy: c.uid, requestedAt: c.now }, (ms) => ms), true);
  return { paymentId, changeCents, dueCents: part.totalCents - part.paidCents - d.amountCents };
}
function registrarCobro(c, d) {
  if (d.method === "card" && !d.terminalReference) fail2("Indica la referencia del dat\xE1fono. Es un registro manual, no un cargo bancario.");
  let externalId = d.terminalReference;
  if (d.method === "deposit") {
    localOnly();
    const bill = account(c, d);
    if (bill.target.kind !== "session") fail2("La se\xF1al solo se aplica a la sesi\xF3n de su reserva.");
    const session = get2(c, "tableSessions", bill.target.id);
    if (!session.reservationId) fail2("Esta sesi\xF3n no procede de una reserva con se\xF1al.");
    const reservation = get2(c, "reservations", session.reservationId), deposit = reservation.deposit;
    if (!deposit || deposit.status !== "paid" || !deposit.checkoutSessionId || d.tipCents) fail2("La reserva no tiene una se\xF1al pagada verificable o se ha pedido propina sobre ella.");
    const used = c.secrets.depositApplications.get(session.reservationId);
    if (sumCents([used?.amountCents ?? 0, d.amountCents]) > deposit.amountCents) fail2("La se\xF1al no tiene saldo suficiente o ya se aplic\xF3.");
    externalId = deposit.checkoutSessionId;
    const result = applyCharge(c, d, d.method, externalId);
    c.secret("depositApplications", session.reservationId, { reservationId: session.reservationId, externalId, paymentId: result.paymentId, amountCents: sumCents([used?.amountCents ?? 0, d.amountCents]) });
    return result;
  }
  return applyCharge(c, d, d.method, externalId, d.tenderedCents);
}
function devolverCobro(c, d) {
  const original = get2(c, "payments", d.paymentId);
  const refunds = [...c.rows.payments.values()].filter((p) => p.originalPaymentId === d.paymentId);
  checkRefund(original, refunds, d.amountCents, d.tipCents);
  const external = original.method === "stripe" || original.method === "deposit";
  if (external) {
    const refundId2 = newId2(c, "payments");
    c.put("payments", refundId2, { ...original, kind: "refund", originalPaymentId: d.paymentId, status: "failed", amountCents: d.amountCents, tipCents: d.tipCents, tenderedCents: 0, changeCents: 0, externalId: null, requestId: d.requestId, reason: d.reason, at: c.now, by: c.uid });
    return { refundId: refundId2, status: "not_configured" };
  }
  const oldCash = get2(c, "cashSessions", original.cashSessionId);
  const cashSessionId = c.secrets.registerLocks.get(oldCash.registerId)?.cashSessionId;
  if (!cashSessionId) fail2("Abre la caja del terminal para registrar la devoluci\xF3n.");
  cashOpen(c, cashSessionId);
  if ([...c.rows.tipDistributions.values()].some((t) => t.cashSessionId === original.cashSessionId) && d.tipCents) fail2("Estas propinas ya est\xE1n repartidas. Revisa su devoluci\xF3n con el encargado.");
  const refundId = newId2(c, "payments");
  c.put("payments", refundId, { ...original, cashSessionId, kind: "refund", originalPaymentId: d.paymentId, status: "succeeded", amountCents: d.amountCents, tipCents: d.tipCents, tenderedCents: 0, changeCents: 0, requestId: d.requestId, reason: d.reason, at: c.now, by: c.uid });
  const bill = get2(c, "bills", original.billId);
  c.put("bills", original.billId, { ...bill, refundedCents: sumCents([bill.refundedCents, d.amountCents]) });
  if (d.amountCents) c.stage(`${c.local.path}/refundReviews/${refundId}`, { paymentId: d.paymentId, refundId, billId: original.billId, partId: original.partId, amountCents: d.amountCents, reason: d.reason, status: "requires_fiscal_correction" }, true);
  return { refundId, status: "succeeded" };
}
async function externalCharge(c, d) {
  const key = hash(["stripe", d.externalId]), previous = c.secrets.paymentEvents.get(key);
  if (previous) {
    if (previous.payloadHash !== hash(d)) fail2("Este pago externo ya est\xE1 asociado a otra intenci\xF3n.");
    return previous.result;
  }
  const checkout = get2(c, "mobileCheckouts", d.checkoutId);
  const metadata = c.checkoutMetadata.get(d.checkoutId);
  if (checkout.status !== "pending" || checkout.billId !== d.billId || checkout.partId !== d.partId || checkout.revision !== d.expectedRevision || checkout.amountCents !== d.amountCents || checkout.tipCents !== d.tipCents || checkout.stripeSessionId !== d.externalId || metadata.cashSessionId !== d.cashSessionId) fail2("El pago externo no coincide con la sesi\xF3n y el saldo reservados. Requiere conciliaci\xF3n.");
  const { paymentId, dueCents } = applyCharge(c, d, "stripe", d.externalId, 0, d.checkoutId);
  c.put("mobileCheckouts", d.checkoutId, { ...checkout, status: "paid" });
  const result = { paymentId, dueCents };
  c.secret("paymentEvents", key, { paymentId, payloadHash: hash(d), result });
  return result;
}

// src/fase3/fiscal.ts
var fiscal_exports = {};
__export(fiscal_exports, {
  anularRegistroFiscal: () => anularRegistroFiscal,
  chainKey: () => chainKey,
  emitirFactura: () => emitirFactura,
  ensureSeries: () => ensureSeries,
  fiscalClock: () => fiscalClock,
  guardarConfiguracionCaja: () => guardarConfiguracionCaja,
  recordIntegrityIncident: () => recordIntegrityIncident,
  rectificarFactura: () => rectificarFactura,
  sustituirSimplificada: () => sustituirSimplificada
});
import { FieldValue as FieldValue8 } from "firebase-admin/firestore";
function fiscalClock(now, timezone) {
  const parts2 = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset" }).formatToParts(now);
  const field = (type) => parts2.find((p) => p.type === type).value;
  const year = field("year"), month = field("month"), day = field("day"), offset = field("timeZoneName").replace("GMT", "") || "+00:00";
  return { year: Number(year), issueDate: `${day}-${month}-${year}`, generatedAt: `${year}-${month}-${day}T${field("hour")}:${field("minute")}:${field("second")}${offset}` };
}
var chainKey = (settings2) => hash([settings2.issuer.nif, settings2.system.installation]);
function validSettings(c, settings2 = c.settings) {
  if (!settings2) fail2("Falta configurar el emisor y las series de caja antes de facturar.");
  localOnly();
  if (settings2.providerId !== "local_test" || settings2.environment !== "test" || settings2.fiscalRegime !== "verifactu") fail2("Solo est\xE1 disponible VERI*FACTU de prueba, no v\xE1lido para Hacienda. TicketBAI requiere proveedor.");
  return settings2;
}
function ensureSeries(c, settings2) {
  const clock = fiscalClock(c.now, c.restaurant.timezone);
  const prefix = `L${hash([c.rid, c.lid]).slice(0, 20).toUpperCase()}/${clock.year}`;
  if (settings2.ordinarySeriesId !== `ordinary_${clock.year}` || settings2.rectifyingSeriesId !== `rectifying_${clock.year}`) fail2("Las series nuevas deben ser las del a\xF1o fiscal actual, creadas por el servidor.");
  for (const kind of ["ordinary", "rectifying"]) {
    const id2 = `${kind}_${clock.year}`, old = c.rows.invoiceSeries.get(id2);
    const expectedPrefix = `${prefix}/${kind === "ordinary" ? "F" : "R"}`;
    if (old) {
      if (old.prefix !== expectedPrefix || old.kind !== kind || old.year !== clock.year || !old.active) fail2("La serie necesita una migraci\xF3n del proveedor.");
      continue;
    }
    c.put("invoiceSeries", id2, { prefix: expectedPrefix, kind, year: clock.year, lastSequence: 0, lastIssueDate: null, active: true });
  }
}
async function guardarConfiguracionCaja(c, d) {
  const settings2 = validSettings(c, d.settings), key = chainKey(settings2);
  const identity = c.settings && { issuer: c.settings.issuer, system: c.settings.system, fiscalRegime: c.settings.fiscalRegime, providerId: c.settings.providerId, environment: c.settings.environment };
  const nextIdentity = { issuer: settings2.issuer, system: settings2.system, fiscalRegime: settings2.fiscalRegime, providerId: settings2.providerId, environment: settings2.environment };
  const ownRecords = await c.tx.get(c.root.collection("fiscalRecords").limit(1));
  if (!ownRecords.empty && identity && JSON.stringify(identity) !== JSON.stringify(nextIdentity)) fail2("El emisor y el sistema usados requieren migraci\xF3n del proveedor. No se reinician cadenas.");
  const binding = c.root.firestore.doc(`fiscalInstallations/${key}`), existing = await c.tx.get(binding);
  if (existing.exists && existing.get("restaurantId") !== c.rid) fail2("Esta instalaci\xF3n fiscal ya pertenece a otro restaurante.");
  const identityHash = hash({ issuer: settings2.issuer, system: settings2.system, regime: settings2.fiscalRegime });
  if (existing.exists && existing.get("identityHash") !== identityHash) fail2("La identidad de esta instalaci\xF3n ya est\xE1 vinculada. Requiere migraci\xF3n del proveedor.");
  if (!existing.exists) c.stage(binding.path, { restaurantId: c.rid, issuerNif: settings2.issuer.nif, installation: settings2.system.installation, identityHash }, true);
  const chain = await c.tx.get(c.root.collection("fiscalChains").doc(key));
  if (chain.exists && (chain.get("issuerNif") !== settings2.issuer.nif || chain.get("installation") !== settings2.system.installation || chain.get("regime") !== settings2.fiscalRegime)) fail2("La instalaci\xF3n requiere migraci\xF3n del proveedor.");
  if (!chain.exists) c.stage(`${c.root.path}/fiscalChains/${key}`, { issuerNif: settings2.issuer.nif, installation: settings2.system.installation, regime: settings2.fiscalRegime, head: null }, true);
  ensureSeries(c, settings2);
  c.stage(`${c.local.path}/settings/pos`, settings2, !c.settings);
  return { ok: true };
}
async function fiscalState(c) {
  const settings2 = validSettings(c), clock = fiscalClock(c.now, c.restaurant.timezone), chainId = chainKey(settings2);
  const current = { ...settings2, ordinarySeriesId: `ordinary_${clock.year}`, rectifyingSeriesId: `rectifying_${clock.year}` };
  ensureSeries(c, current);
  if (settings2.ordinarySeriesId !== current.ordinarySeriesId || settings2.rectifyingSeriesId !== current.rectifyingSeriesId) c.stage(`${c.local.path}/settings/pos`, current);
  const [chainDoc, records, binding] = await Promise.all([
    c.tx.get(c.root.collection("fiscalChains").doc(chainId)),
    c.tx.get(c.root.collection("fiscalRecords").where("input.chainId", "==", chainId).orderBy("input.chainSequence")),
    c.tx.get(c.root.firestore.doc(`fiscalInstallations/${chainId}`))
  ]);
  if (!binding.exists || binding.get("restaurantId") !== c.rid || !chainDoc.exists) fail2("La instalaci\xF3n fiscal no est\xE1 vinculada a este restaurante.");
  const chain = FiscalChainSchema.parse(chainDoc.data()), stored = records.docs.map((d) => FiscalStoredRecordSchema.parse(d.data()));
  const last = stored.at(-1), identity = last ? fiscalIdentity(last.input) : null;
  const expected = last ? { ...identity, recordId: last.input.recordId, hash: last.hash, sequence: last.input.chainSequence } : null;
  if (!verifyFiscalChain(stored) || JSON.stringify(chain.head) !== JSON.stringify(expected) || chain.issuerNif !== settings2.issuer.nif || chain.installation !== settings2.system.installation || chain.regime !== settings2.fiscalRegime || stored.some((r) => JSON.stringify(r.input.system) !== JSON.stringify(settings2.system))) fail2("La integridad de la cadena fiscal no coincide. Se bloquea la emisi\xF3n y debe revisarla el encargado.");
  if (last && Date.parse(last.input.generatedAt) > c.now) fail2("El reloj fiscal retrocede respecto al \xFAltimo registro.");
  const previous = chain.head ? { recordId: chain.head.recordId, hash: chain.head.hash, issuerNif: chain.head.issuerNif, number: chain.head.number, issueDate: chain.head.issueDate } : null;
  return { settings: current, clock, chainId, chain, previous, sequence: (chain.head?.sequence ?? 0) + 1 };
}
function number(c, s, type) {
  const seriesId = type.startsWith("R") ? s.settings.rectifyingSeriesId : s.settings.ordinarySeriesId;
  const series = get2(c, "invoiceSeries", seriesId);
  const issued = [...c.rows.invoices.values()].filter((i) => i.seriesId === seriesId).sort((a, b) => a.sequence - b.sequence);
  if (issued.length !== series.lastSequence || issued.some((i, index) => i.sequence !== index + 1)) fail2("El correlativo de la serie no coincide con sus facturas. Requiere revisi\xF3n.");
  const next = nextInvoiceNumber(series, type, s.clock.issueDate);
  return { seriesId, series, next };
}
async function save(c, s, invoiceId, input, invoice, numbering) {
  const artifact = createTestFiscalProvider().prepare({ regime: s.settings.fiscalRegime, record: input, ticketbaiPrevious: null });
  const { record, ...originalArtifact } = artifact;
  const recordId = input.recordId;
  if (invoice && numbering) {
    const key = hash([invoice.issuer.nif, invoice.number]), ref = c.root.collection("invoiceNumbers").doc(key);
    if ((await c.tx.get(ref)).exists) fail2("Este n\xFAmero fiscal ya existe. La serie requiere revisi\xF3n.");
    c.stage(ref.path, { locationId: c.lid, invoiceId }, true);
    c.put("invoiceSeries", numbering.seriesId, { ...numbering.series, lastSequence: numbering.next.sequence, lastIssueDate: invoice.issueDate });
    c.stage(`${c.local.path}/invoices/${invoiceId}`, { ...invoice, recordId, artifact: originalArtifact }, true);
    c.stage(`${c.local.path}/printRequests/${hash(["invoice", invoiceId])}`, { kind: "invoice", sourceId: invoiceId, printerId: null, copy: 0, status: "queued", requestedBy: c.uid, requestedAt: c.now }, true);
  }
  c.stage(`${c.root.path}/fiscalRecords/${recordId}`, { ...record, locationId: c.lid, invoiceId, ...originalArtifact }, true);
  const identity = fiscalIdentity(input);
  c.stage(`${c.root.path}/fiscalChains/${s.chainId}`, { ...s.chain, head: { ...identity, recordId, hash: record.hash, sequence: s.sequence } });
  c.stage(`${c.root.path}/fiscalOutbox/${recordId}`, { recordId, chainId: s.chainId, locationId: c.lid, invoiceId, status: "queued", attempts: 0, nextAttemptAt: c.now, leaseUntil: null, leaseOwner: null }, true);
  return { invoiceId, recordId, number: identity.number, fiscalStatus: "queued", warning: FISCAL_TEST_WARNING };
}
function alta(c, s, invoice) {
  return { recordId: newId2(c, "fiscalRecords"), chainId: s.chainId, chainSequence: s.sequence, version: "1.0", kind: "alta", invoice, system: s.settings.system, generatedAt: s.clock.generatedAt, previous: s.previous, correctionOfRecordId: null, subsanacion: false, previousRejection: false };
}
async function emitirFactura(c, d) {
  const bill = account(c, d), part = get2(c, "billParts", d.partId);
  if (!["locked", "settled"].includes(bill.status) || part.billId !== d.billId || part.revision !== bill.revision) fail2("La factura necesita una parte de esta cuenta bloqueada.");
  if (part.invoiceId) {
    const stored = await c.tx.get(c.local.collection("invoices").doc(part.invoiceId));
    const invoice2 = InvoiceSchema.parse(stored.data());
    if (invoice2.type !== d.type || JSON.stringify(invoice2.recipient) !== JSON.stringify(d.recipient) || invoice2.qualifiedSimplified !== d.qualifiedSimplified) fail2("Esta parte ya est\xE1 facturada con otros datos. Usa una correcci\xF3n.");
    return { invoiceId: part.invoiceId, recordId: stored.get("recordId"), number: invoice2.number, fiscalStatus: "queued", warning: FISCAL_TEST_WARNING };
  }
  const s = await fiscalState(c), n = number(c, s, d.type);
  const lines = invoiceLinesForPart(netBillLines(bill.lines, bill.adjustments), part);
  const invoice = InvoiceSchema.parse({ billId: d.billId, partId: d.partId, issuer: s.settings.issuer, recipient: d.recipient, seriesId: n.seriesId, sequence: n.next.sequence, number: n.next.number, issueDate: s.clock.issueDate, operationDate: s.clock.issueDate, type: d.type, qualifiedSimplified: d.qualifiedSimplified, description: "Servicio de restauraci\xF3n de prueba, no v\xE1lido para Hacienda", lines, ...invoiceTotals(lines), correction: null, replacedInvoices: [] });
  const invoiceId = newId2(c, "invoices"), result = await save(c, s, invoiceId, alta(c, s, invoice), invoice, n);
  c.put("billParts", d.partId, { ...part, invoiceId });
  return result;
}
function originalEvents(c, invoiceId) {
  return [...c.secrets.invoiceEvents.values()].filter((e) => e.invoiceId === invoiceId);
}
async function rectificarFactura(c, d) {
  const original = get2(c, "invoices", d.invoiceId), events = originalEvents(c, d.invoiceId);
  if (original.type.startsWith("R") || events.some((e) => e.kind === "cancelled" || e.kind === "replaced")) fail2("Esta factura requiere revisi\xF3n del proveedor antes de corregirla.");
  if (original.type === "F2" || original.qualifiedSimplified ? d.type !== "R5" : !["R1", "R2", "R3", "R4"].includes(d.type)) fail2("El tipo de rectificaci\xF3n no corresponde al documento original.");
  const remaining = original.lines.map((line, lineIndex) => {
    const reduced = sumCents(events.flatMap((e) => e.kind === "rectified" ? e.reductions.filter((r) => r.lineIndex === lineIndex).map((r) => r.amountCents) : []));
    return { ...line, quantity: 1, unitPriceCents: line.grossCents - reduced, discountCents: 0, grossCents: line.grossCents - reduced };
  });
  const current = InvoiceSchema.parse({ ...original, lines: remaining, ...invoiceTotals(remaining) });
  const s = await fiscalState(c), n = number(c, s, d.type);
  const invoice = rectifyInvoice(current, { ...d, seriesId: n.seriesId, sequence: n.next.sequence, number: n.next.number, issueDate: s.clock.issueDate });
  const id2 = newId2(c, "invoices"), result = await save(c, s, id2, alta(c, s, invoice), invoice, n);
  c.secret("invoiceEvents", newId2(c, "invoiceEvents"), { invoiceId: d.invoiceId, kind: "rectified", correctionInvoiceId: id2, reductions: d.reductions, mode: d.mode, reason: d.reason });
  return result;
}
async function sustituirSimplificada(c, d) {
  const original = get2(c, "invoices", d.invoiceId);
  if (original.type !== "F2" || originalEvents(c, d.invoiceId).length) fail2("Solo se sustituye una simplificada que no tenga correcciones ni sustituci\xF3n.");
  const s = await fiscalState(c), n = number(c, s, "F3");
  const invoice = InvoiceSchema.parse({ ...original, type: "F3", recipient: d.recipient, seriesId: n.seriesId, sequence: n.next.sequence, number: n.next.number, issueDate: s.clock.issueDate, replacedInvoices: [invoiceIdentity(original)] });
  const id2 = newId2(c, "invoices"), result = await save(c, s, id2, alta(c, s, invoice), invoice, n);
  c.secret("invoiceEvents", newId2(c, "invoiceEvents"), { invoiceId: d.invoiceId, kind: "replaced", replacementInvoiceId: id2 });
  return result;
}
async function anularRegistroFiscal(c, d) {
  const invoice = get2(c, "invoices", d.invoiceId), bill = get2(c, "bills", invoice.billId);
  if (originalEvents(c, d.invoiceId).length) fail2("La factura ya tiene una incidencia. Debe revisarla el encargado.");
  const dest = invoice.billId && (bill.target.kind === "session" ? get2(c, "tableSessions", bill.target.id) : get2(c, "takeaways", bill.target.id));
  if (bill.paidCents || !dest || dest.status !== "cancelled") fail2("La anulaci\xF3n exige ausencia de operaci\xF3n y de cobros. Para una venta real emite rectificativa.");
  const s = await fiscalState(c);
  const input = { recordId: newId2(c, "fiscalRecords"), chainId: s.chainId, chainSequence: s.sequence, version: "1.0", kind: "anulacion", invoice: invoiceIdentity(invoice), system: s.settings.system, generatedAt: s.clock.generatedAt, previous: s.previous, reason: d.reason, noPreviousRecord: false, previousRejection: false };
  const result = await save(c, s, d.invoiceId, input, null);
  c.secret("invoiceEvents", newId2(c, "invoiceEvents"), { invoiceId: d.invoiceId, kind: "cancelled", recordId: result.recordId, reason: d.reason });
  return { recordId: result.recordId, fiscalStatus: result.fiscalStatus };
}
async function recordIntegrityIncident(rid, lid, message) {
  const { db: db2 } = await import("./shared-VCUUCKM2.js");
  await db2.doc(`restaurants/${rid}/fiscalIncidents/${hash([lid, message])}`).set({ locationId: lid, message, updatedAt: FieldValue8.serverTimestamp() }, { merge: true });
}

// src/fase3/index.ts
var handlers2 = { ...accounts_exports, ...cash_exports, ...payments_exports, ...fiscal_exports };
var actions2 = {
  guardarConfiguracionCaja: "pos.settingsChanged",
  abrirCaja: "cash.opened",
  cerrarCaja: "cash.closed",
  registrarMovimientoCaja: "cash.movement",
  abrirCuenta: "bill.opened",
  verCuenta: "bill.refreshed",
  ajustarCuenta: "bill.adjusted",
  dividirCuenta: "bill.split",
  prepararCobro: "bill.locked",
  desbloquearCuenta: "bill.unlocked",
  registrarCobro: "payment.recorded",
  devolverCobro: "payment.refunded",
  emitirFactura: "invoice.issued",
  rectificarFactura: "invoice.rectified",
  sustituirSimplificada: "invoice.replaced",
  anularRegistroFiscal: "fiscal.cancelled",
  repartirPropinas: "tips.distributed"
};
async function execute2(name, data, request) {
  const schema = CALLABLE_SCHEMAS_FASE3[name];
  const d = parse(schema.input, data);
  const scope = d;
  const uid = request ? uidOf(request) : null;
  try {
    const result = await db.runTransaction(async (tx) => {
      const c = await context3(tx, scope.restaurantId, scope.locationId, name, request);
      if (!request && name !== "emitirFactura") throw new HttpsError13("permission-denied", "La operaci\xF3n necesita personal autenticado.");
      const key = scope.requestId ? hash([uid, name, scope.requestId]) : null;
      const intent = key ? c.local.collection("posRequests").doc(key) : null;
      const old = intent ? await tx.get(intent) : null;
      const payloadHash = hash(d);
      if (old?.exists) {
        if (old.get("payloadHash") !== payloadHash) throw new HttpsError13("already-exists", "Esta petici\xF3n ya se us\xF3 con otros datos.");
        return { value: schema.output.parse(old.get("result")) };
      }
      if (!request) {
        const invoice = d;
        const checkouts = await tx.get(c.local.collection("mobileCheckouts").where("partId", "==", invoice.partId));
        const permitted = checkouts.docs.some((doc) => doc.get("status") === "paid" && doc.get("billId") === invoice.billId && doc.get("revision") === invoice.expectedRevision && JSON.stringify(doc.get("recipient") ?? null) === JSON.stringify(invoice.recipient) && (invoice.recipient === null && invoice.type === "F2" || invoice.recipient !== null && invoice.type === "F1" && !invoice.qualifiedSimplified));
        if (!permitted) throw new HttpsError13("permission-denied", "La emisi\xF3n autom\xE1tica exige un Checkout confirmado y su destinatario guardado.");
      }
      if (scope.billId && name !== "verCuenta" && name !== "abrirCuenta" && c.rows.bills.get(scope.billId)?.status === "open") {
        if (refresh(c, scope.billId)) {
          c.flush("bill.refreshed", "Consumo de la cuenta actualizado.", { billId: scope.billId });
          return { stale: true };
        }
      }
      const handle = handlers2[name];
      const value = schema.output.parse(await handle(c, d));
      if (intent) c.stage(intent.path, { requestId: scope.requestId, actorUid: uid, route: name, payloadHash, result: value }, true);
      const action = name === "registrarCobro" && c.rows.bills.get(scope.billId)?.status === "settled" ? "bill.settled" : actions2[name];
      c.flush(name === "verCuenta" && !c.writes.size ? null : action, "Operaci\xF3n de caja registrada.", { requestId: scope.requestId ?? null, billId: scope.billId ?? null, reason: scope.reason ?? null, operation: name });
      return { value };
    }, { maxAttempts: 10 });
    if ("stale" in result) fail2("El consumo ha cambiado y se ha actualizado la cuenta. Recarga y vuelve a repartir antes de cobrar.");
    return result.value;
  } catch (error) {
    if (error instanceof HttpsError13) {
      if (error.message.includes("integridad de la cadena")) await recordIntegrityIncident(scope.restaurantId, scope.locationId, error.message);
      throw error;
    }
    if (error instanceof external_exports.ZodError || error instanceof Error && !("code" in error)) throw new HttpsError13("failed-precondition", error instanceof external_exports.ZodError ? error.issues.map((i) => i.message).join(" ").slice(0, 400) : error.message);
    throw error;
  }
}
function callable3(name) {
  return onCall10(options, (request) => safe(() => execute2(name, request.data, request)));
}
var guardarConfiguracionCaja2 = callable3("guardarConfiguracionCaja");
var abrirCaja2 = callable3("abrirCaja");
var cerrarCaja2 = callable3("cerrarCaja");
var registrarMovimientoCaja2 = callable3("registrarMovimientoCaja");
var abrirCuenta2 = callable3("abrirCuenta");
var verCuenta2 = callable3("verCuenta");
var ajustarCuenta2 = callable3("ajustarCuenta");
var dividirCuenta2 = callable3("dividirCuenta");
var prepararCobro2 = callable3("prepararCobro");
var desbloquearCuenta2 = callable3("desbloquearCuenta");
var registrarCobro2 = callable3("registrarCobro");
var devolverCobro2 = callable3("devolverCobro");
var emitirFactura2 = callable3("emitirFactura");
var rectificarFactura2 = callable3("rectificarFactura");
var sustituirSimplificada2 = callable3("sustituirSimplificada");
var anularRegistroFiscal2 = callable3("anularRegistroFiscal");
var repartirPropinas2 = callable3("repartirPropinas");
export {
  abrirCaja2 as abrirCaja,
  abrirCuenta2 as abrirCuenta,
  abrirMesa2 as abrirMesa,
  aceptarOfertaListaEspera,
  actividadSala,
  activityArea,
  activityMember,
  activityRestaurant,
  activityTable,
  ajustarCuenta2 as ajustarCuenta,
  anularRegistroFiscal2 as anularRegistroFiscal,
  apuntarseListaEspera,
  asignarMesas,
  avisarDesdeMesa2 as avisarDesdeMesa,
  cambiarEstadoLineas2 as cambiarEstadoLineas,
  cambiarEstadoMesa2 as cambiarEstadoMesa,
  cambiarEstadoParaLlevar2 as cambiarEstadoParaLlevar,
  cambiarEstadoReserva,
  cambiarEstadoTarea2 as cambiarEstadoTarea,
  cambiarPlan,
  cambiarRolMiembro,
  cartaLocal,
  cartaPublica,
  cartaRestaurante,
  cerrarCaja2 as cerrarCaja,
  consultarDisponibilidad,
  consultarRecogida2 as consultarRecogida,
  crearParaLlevar2 as crearParaLlevar,
  crearReserva,
  crearReservaPublica,
  crearRestaurante,
  crearTarea2 as crearTarea,
  decidirPedido2 as decidirPedido,
  desactivarMiembro,
  desbloquearCuenta2 as desbloquearCuenta,
  devolverCobro2 as devolverCobro,
  dividirCuenta2 as dividirCuenta,
  editarMesa2 as editarMesa,
  emitirFactura2 as emitirFactura,
  enviarPedido2 as enviarPedido,
  execute2 as execute,
  gestionarReservaPublica,
  guardarCategoriaCarta2 as guardarCategoriaCarta,
  guardarConfiguracionCaja2 as guardarConfiguracionCaja,
  guardarConfiguracionReservas,
  guardarConfiguracionSala2 as guardarConfiguracionSala,
  guardarEstacion2 as guardarEstacion,
  guardarMenuDia2 as guardarMenuDia,
  guardarPlato2 as guardarPlato,
  importarReservas,
  iniciarPagoSenal,
  invitarMiembro,
  juntarMesas2 as juntarMesas,
  marcarAgotado2 as marcarAgotado,
  marcharParaLlevar,
  marcharPase2 as marcharPase,
  mensajeCreado,
  mensajesProgramados,
  mensajesReservaActualizada,
  moverMesa2 as moverMesa,
  moverReserva,
  names,
  ordenarCarta2 as ordenarCarta,
  pedirDesdeMesa2 as pedirDesdeMesa,
  pedirParaLlevar2 as pedirParaLlevar,
  prepararCobro2 as prepararCobro,
  procesarMensajesPendientes,
  proponerMesasReserva,
  publicLocationChanged,
  publicRestaurantChanged,
  publicSettingsChanged,
  reconciliarSala,
  rectificarFactura2 as rectificarFactura,
  regenerarQrMesa2 as regenerarQrMesa,
  registrarCobro2 as registrarCobro,
  registrarMovimientoCaja2 as registrarMovimientoCaja,
  repartirPropinas2 as repartirPropinas,
  reservationChanged,
  separarMesas2 as separarMesas,
  stripeWebhook,
  sustituirSimplificada2 as sustituirSimplificada,
  verCuenta2 as verCuenta,
  verMesaPublica2 as verMesaPublica,
  verParaLlevarPublico2 as verParaLlevarPublico,
  verReservaPublica,
  whatsappWebhook
};
//# sourceMappingURL=emulator-entry.js.map