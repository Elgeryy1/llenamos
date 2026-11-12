import type { AvailabilityOutput, AvailabilitySlot } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import { translator } from "./i18n"
import {
  cancellationText,
  createBookingInput,
  dayStatus,
  depositPolicyText,
  EMPTY_GUEST,
  groupSlots,
  initialPartySize,
  money,
  partySizeButtons,
  partySizeExtra,
  slotState,
  telHref,
  validateGuest,
  waitlistTimes,
} from "./reserva"

const es = translator("es")
const ca = translator("ca")

function slot(time: string, shift: string, available = true, reason: AvailabilitySlot["reason"] = null): AvailabilitySlot {
  return { time, wallDate: "2026-11-12", startAt: 0, shift, available, reason }
}

describe("personas", () => {
  it("enseña botones hasta 8 y el resto en el desplegable", () => {
    expect(partySizeButtons(1, 8)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
    expect(partySizeExtra(1, 8)).toEqual([])
    expect(partySizeButtons(2, 12)).toEqual([2, 3, 4, 5, 6, 7, 8, 9])
    expect(partySizeExtra(2, 12)).toEqual([10, 11, 12])
    expect(partySizeButtons(1, 4)).toEqual([1, 2, 3, 4])
  })

  it("empieza en 2 si cabe", () => {
    expect(initialPartySize(1, 8)).toBe(2)
    expect(initialPartySize(4, 8)).toBe(4)
    expect(initialPartySize(1, 1)).toBe(1)
  })
})

describe("horas", () => {
  it("agrupa por turno, traduce el turno y oculta las que ya pasaron", () => {
    const groups = groupSlots(
      [slot("13:00", "Comida", false, "min_notice"), slot("13:30", "Comida"), slot("20:00", "Cena", false, "slot_capacity"), slot("20:30", "Cena")],
      "ca",
    )
    expect(groups.map((g) => [g.label, g.slots.map((s) => s.time)])).toEqual([
      ["Dinar", ["13:30"]],
      ["Sopar", ["20:00", "20:30"]],
    ])
  })

  it("explica por qué una hora no está libre", () => {
    expect(slotState(slot("20:00", "Cena"))).toBe("available")
    expect(slotState(slot("20:00", "Cena", false, "no_table"))).toBe("full")
    expect(slotState(slot("20:00", "Cena", false, "shift_capacity"))).toBe("full")
    expect(slotState(slot("20:00", "Cena", false, "max_advance"))).toBe("too_far")
  })

  it("distingue cerrado, grupo no admitido, sin horas y lleno", () => {
    const base: AvailabilityOutput = { date: "2026-11-16", partySize: 2, durationMinutes: 90, timezone: "Europe/Madrid", status: "open", message: null, slots: [], waitlistEnabled: true }
    expect(dayStatus({ ...base, status: "closed" }, "es").kind).toBe("closed")
    expect(dayStatus({ ...base, status: "party_size_not_allowed" }, "es").kind).toBe("party_size_not_allowed")
    expect(dayStatus(base, "es").kind).toBe("no_slots")
    const lleno = dayStatus({ ...base, slots: [slot("21:00", "Cena", false, "slot_capacity")] }, "es")
    expect(lleno).toMatchObject({ kind: "open", anyAvailable: false })
  })

  it("ofrece para la lista de espera todas las horas del día que no han pasado", () => {
    expect(waitlistTimes([slot("13:00", "Comida", false, "min_notice"), slot("20:00", "Cena", false, "no_table"), slot("20:30", "Cena")])).toEqual(["20:00", "20:30"])
  })
})

describe("políticas", () => {
  it("explica la señal y la cancelación", () => {
    expect(depositPolicyText({ mode: "none", amountCents: 0, fromPartySize: 1 }, "es", es)).toBeNull()
    const plain = (s: string | null) => s?.replace(/ /g, " ")
    expect(plain(depositPolicyText({ mode: "perPerson", amountCents: 500, fromPartySize: 5 }, "es", es))).toBe("Grupos de 5 o más: señal de 5 € por persona.")
    expect(plain(depositPolicyText({ mode: "perPerson", amountCents: 1000, fromPartySize: 1 }, "en", translator("en")))).toBe("A deposit of €10 per person is required.")
    expect(plain(money(450, "es"))).toBe("4,50 €")
    expect(cancellationText(24, es)).toBe("Puedes cancelar gratis hasta 24 horas antes.")
    expect(cancellationText(1, ca)).toBe("Pots cancel·lar gratis fins a 1 hora abans.")
    expect(cancellationText(0, es)).toBe("Puedes cancelar gratis cuando quieras.")
  })
})

describe("datos del cliente", () => {
  it("pide nombre, teléfono válido y aceptar la política", () => {
    const r = validateGuest(EMPTY_GUEST, es)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.errors).sort()).toEqual(["acceptPolicy", "name", "phone"])
  })

  it("normaliza el teléfono a E.164 con normalizePhone y el correo opcional", () => {
    const r = validateGuest({ ...EMPTY_GUEST, name: "  Clara Puig ", phone: "612 34 56 78", acceptPolicy: true, notes: " Alergia a frutos secos " }, es)
    expect(r).toEqual({ ok: true, value: { guestName: "Clara Puig", phone: "+34612345678", email: null, guestNotes: "Alergia a frutos secos" } })
    const extranjero = validateGuest({ ...EMPTY_GUEST, name: "Ann", phone: "+44 20 7946 0958", email: "Ann@Example.com", acceptPolicy: true }, es)
    expect(extranjero.ok && extranjero.value).toMatchObject({ phone: "+442079460958", email: "ann@example.com" })
  })

  it("explica los errores en el idioma de la página", () => {
    const r = validateGuest({ ...EMPTY_GUEST, name: "Clara", phone: "1234", email: "no", acceptPolicy: true }, ca)
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.phone).toBe(ca("errPhone"))
      expect(r.errors.email).toBe("Aquest correu no sembla vàlid.")
    }
    const largo = validateGuest({ ...EMPTY_GUEST, name: "Clara", phone: "612345678", acceptPolicy: true, notes: "x".repeat(501) }, es)
    expect(!largo.ok && largo.errors.notes).toBe(es("errNotesLong"))
  })

  it("arma la entrada de crearReservaPublica con el origen y el campo trampa", () => {
    const input = createBookingInput(
      "taberna-lumbre",
      { locationId: "centro", date: "2026-11-12", time: "21:00", partySize: 3 },
      { guestName: "Clara", phone: "+34612345678", email: null, guestNotes: "" },
      { ...EMPTY_GUEST, website: "" },
      "ca",
      "widget",
    )
    expect(input).toMatchObject({ source: "widget", language: "ca", acceptPolicy: true, website: "", partySize: 3, time: "21:00" })
  })

  it("limpia el teléfono para llamar", () => {
    expect(telHref("93 123 45 67")).toBe("tel:931234567")
    expect(telHref("+34 (93) 123-45-67")).toBe("tel:+34931234567")
  })
})
