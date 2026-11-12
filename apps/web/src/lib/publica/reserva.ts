/**
 * Lógica del formulario público de reservas, sin React: qué opciones se enseñan, cómo
 * se agrupan las horas, la validación de los datos y lo que se envía a las callables.
 */
import {
  depositAmountFor,
  EmailSchema,
  formatMoney,
  GuestNameSchema,
  NotesSchema,
  tryNormalizePhone,
  type AvailabilityOutput,
  type AvailabilitySlot,
  type CallableInput,
  type DepositPolicy,
  type Language,
  type PublicRestaurant,
} from "@llenamos/core"
import { INTL_LOCALE, shiftLabel, type TextKey, type Translate } from "./i18n"

/* Personas ------------------------------------------------------------------ */

/** Botones de personas que caben en la rejilla; el resto va en un desplegable. */
export const MAX_SIZE_BUTTONS = 8

export function partySizeButtons(min: number, max: number): number[] {
  const top = Math.min(max, min + MAX_SIZE_BUTTONS - 1)
  return Array.from({ length: Math.max(0, top - min + 1) }, (_, i) => min + i)
}

/** Tamaños que no caben en los botones (para el desplegable «más personas»). */
export function partySizeExtra(min: number, max: number): number[] {
  const buttons = partySizeButtons(min, max)
  const last = buttons.at(-1) ?? min - 1
  return Array.from({ length: Math.max(0, max - last) }, (_, i) => last + 1 + i)
}

export function initialPartySize(min: number, max: number): number {
  return Math.min(Math.max(2, min), max)
}

/* Horas --------------------------------------------------------------------- */

export type SlotState = "available" | "full" | "too_soon" | "too_far"

export function slotState(slot: AvailabilitySlot): SlotState {
  if (slot.available) return "available"
  if (slot.reason === "min_notice") return "too_soon"
  if (slot.reason === "max_advance") return "too_far"
  return "full"
}

export const SLOT_STATE_TEXT: Record<Exclude<SlotState, "available">, TextKey> = {
  full: "slotFull",
  too_soon: "slotTooSoon",
  too_far: "slotTooFar",
}

export interface ShiftGroup {
  shift: string
  label: string
  slots: AvailabilitySlot[]
}

/** Agrupa las franjas por turno, en el orden en que llegan. Las que ya pasaron no se enseñan. */
export function groupSlots(slots: AvailabilitySlot[], lang: Language): ShiftGroup[] {
  const groups: ShiftGroup[] = []
  for (const slot of slots) {
    if (slot.reason === "min_notice") continue
    let group = groups.find((g) => g.shift === slot.shift)
    if (!group) {
      group = { shift: slot.shift, label: shiftLabel(slot.shift, lang), slots: [] }
      groups.push(group)
    }
    group.slots.push(slot)
  }
  return groups
}

export type DayStatus =
  | { kind: "open"; groups: ShiftGroup[]; anyAvailable: boolean }
  | { kind: "closed" }
  | { kind: "party_size_not_allowed" }
  | { kind: "no_slots" }

export function dayStatus(availability: AvailabilityOutput, lang: Language): DayStatus {
  if (availability.status === "closed") return { kind: "closed" }
  if (availability.status === "party_size_not_allowed") return { kind: "party_size_not_allowed" }
  const groups = groupSlots(availability.slots, lang)
  if (groups.length === 0) return { kind: "no_slots" }
  return { kind: "open", groups, anyAvailable: groups.some((g) => g.slots.some((s) => s.available)) }
}

/** Para pedir y guardar las horas de un día sin repetir llamadas. */
export function availabilityKey(locationId: string, date: string, partySize: number): string {
  return `${locationId}|${date}|${partySize}`
}

/* Políticas ----------------------------------------------------------------- */

/** «5 €» si son euros enteros; «4,50 €» si hay céntimos. */
export function money(cents: number, lang: Language): string {
  if (cents % 100 !== 0) return formatMoney(cents, "EUR", INTL_LOCALE[lang])
  return new Intl.NumberFormat(INTL_LOCALE[lang], { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(cents / 100)
}

/** «Grupos de 5 o más: señal de 5 € por persona.» o null si no se pide señal. */
export function depositPolicyText(policy: DepositPolicy, lang: Language, t: Translate): string | null {
  if (policy.mode === "none" || policy.amountCents <= 0) return null
  const amount = money(policy.amountCents, lang)
  return policy.fromPartySize <= 1 ? t("depositPolicyAll", { amount }) : t("depositPolicyFrom", { from: policy.fromPartySize, amount })
}

export function depositForParty(policy: DepositPolicy, partySize: number): number {
  return depositAmountFor(policy, partySize)
}

export function cancellationText(freeUntilHours: number, t: Translate): string {
  if (freeUntilHours <= 0) return t("cancelAnytime")
  if (freeUntilHours === 1) return t("cancelFreeHour")
  return t("cancelFreeHours", { hours: freeUntilHours })
}

/* Datos del cliente --------------------------------------------------------- */

export interface GuestForm {
  name: string
  phone: string
  email: string
  notes: string
  acceptPolicy: boolean
  /** Campo trampa: una persona no lo ve ni lo rellena. */
  website: string
}

export const EMPTY_GUEST: GuestForm = { name: "", phone: "", email: "", notes: "", acceptPolicy: false, website: "" }

export type GuestField = "name" | "phone" | "email" | "notes" | "acceptPolicy"
export type GuestErrors = Partial<Record<GuestField, string>>

export interface ValidGuest {
  guestName: string
  phone: string
  email: string | null
  guestNotes: string
}

export function validateContact(
  form: Pick<GuestForm, "name" | "phone" | "email">,
  t: Translate,
): { errors: GuestErrors; value: Omit<ValidGuest, "guestNotes"> | null } {
  const errors: GuestErrors = {}
  const name = form.name.trim()
  if (name === "") errors.name = t("errName")
  else if (!GuestNameSchema.safeParse(name).success) errors.name = t("errNameLong")

  let phone: string | null = null
  if (form.phone.trim() === "") errors.phone = t("errPhoneEmpty")
  else {
    phone = tryNormalizePhone(form.phone)
    if (!phone) errors.phone = t("errPhone")
  }

  const emailRaw = form.email.trim()
  const email = emailRaw === "" ? null : EmailSchema.safeParse(emailRaw)
  if (email && !email.success) errors.email = t("errEmail")

  if (Object.keys(errors).length > 0 || !phone) return { errors, value: null }
  return { errors, value: { guestName: name, phone, email: email && email.success ? email.data : null } }
}

export function validateGuest(form: GuestForm, t: Translate): { ok: true; value: ValidGuest } | { ok: false; errors: GuestErrors } {
  const contact = validateContact(form, t)
  const errors: GuestErrors = { ...contact.errors }
  if (!NotesSchema.safeParse(form.notes.trim()).success) errors.notes = t("errNotesLong")
  if (!form.acceptPolicy) errors.acceptPolicy = t("errPolicy")
  if (Object.keys(errors).length > 0 || !contact.value) return { ok: false, errors }
  return { ok: true, value: { ...contact.value, guestNotes: form.notes.trim() } }
}

/* Entradas de las callables -------------------------------------------------- */

export interface Selection {
  locationId: string
  date: string
  partySize: number
  time: string
}

export function createBookingInput(
  slug: string,
  selection: Selection,
  guest: ValidGuest,
  form: GuestForm,
  lang: Language,
  source: "web" | "widget",
): CallableInput<"crearReservaPublica"> {
  return {
    slug,
    locationId: selection.locationId,
    date: selection.date,
    time: selection.time,
    partySize: selection.partySize,
    guestName: guest.guestName,
    phone: guest.phone,
    email: guest.email,
    language: lang,
    guestNotes: guest.guestNotes,
    acceptPolicy: true,
    source,
    website: form.website,
  }
}

/** Horas de la lista de espera: del primer al último hueco del día (o del turno elegido). */
export function waitlistTimes(slots: AvailabilitySlot[]): string[] {
  return [...new Set(slots.filter((s) => s.reason !== "min_notice").map((s) => s.time))]
}

/** Locales que se pueden elegir: los que la proyección pública marca como reservables. */
export function bookableLocations(restaurant: PublicRestaurant) {
  return restaurant.locations
}

/** Teléfono del local para «llamar», si lo hay. */
export function phoneOf(restaurant: PublicRestaurant, locationId: string | null): string | null {
  const location = restaurant.locations.find((l) => l.id === locationId) ?? restaurant.locations[0]
  const phone = location?.phone.trim()
  return phone ? phone : null
}

/** `tel:` limpio para un teléfono escrito a mano. */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, "")}`
}
