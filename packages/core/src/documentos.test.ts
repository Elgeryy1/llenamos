import { describe, expect, it } from "vitest"
import {
  CustomerEditableSchema,
  customerForWrite,
  customerIdFor,
  CustomerSchema,
  depositAmountFor,
  MessageRequestSchema,
  messageForWrite,
  MessageSchema,
  PublicRestaurantSchema,
  queuedMessage,
  reservationForWrite,
  ReservationSchema,
  sha256Hex,
  WaitlistEntrySchema,
  waitlistEntryForWrite,
} from "./index"

const MS = Date.UTC(2026, 10, 10, 20, 0)
const CID = customerIdFor("demo-lumbre", "+34612345678")

/** Imita un Timestamp de Firestore. */
class TimestampFalso {
  constructor(readonly ms: number) {}
  toMillis() {
    return this.ms
  }
}

const reservaDoc = {
  guestName: "Ana Puig",
  phone: "+34612345678",
  email: "Ana@Ejemplo.com",
  language: "ca",
  partySize: 4,
  startAt: new TimestampFalso(MS),
  durationMinutes: 105,
  status: "confirmed",
  tableIds: ["S3"],
  suggestedTableIds: ["S3"],
  suggestionReason: "S3: 4 plazas, no sobra ninguna.",
  source: "web",
  notes: "",
  guestNotes: "Celebramos un cumpleaños",
  customerId: CID,
  reference: "K7M2QX",
  manageTokenHash: sha256Hex("token-secreto"),
  deposit: { status: "none", amountCents: 0, checkoutSessionId: null },
  history: [{ from: "pending", to: "confirmed", at: new TimestampFalso(MS - 3_600_000), by: null, reason: null }],
  createdBy: null,
  createdAt: new TimestampFalso(MS - 7_200_000),
  updatedAt: new TimestampFalso(MS - 3_600_000),
}

describe("reserva guardada", () => {
  it("se lee con las horas en ms y sin los campos del servidor", () => {
    const r = ReservationSchema.parse(reservaDoc)
    expect(r.startAt).toBe(MS)
    expect(r.history[0]?.at).toBe(MS - 3_600_000)
    expect(r.email).toBe("ana@ejemplo.com")
    expect("createdAt" in r).toBe(false)
  })

  it("rechaza lo que no cumple el contrato", () => {
    const mal = (cambios: Record<string, unknown>) => ReservationSchema.safeParse({ ...reservaDoc, ...cambios }).success
    expect(mal({ phone: "612345678" })).toBe(false)
    expect(mal({ status: "confirmada" })).toBe(false)
    expect(mal({ source: "telefono" })).toBe(false)
    expect(mal({ startAt: "2026-11-10T20:00:00Z" })).toBe(false)
    expect(mal({ reference: "K7M2Q0" })).toBe(false)
    expect(mal({ manageTokenHash: "token-secreto" })).toBe(false)
    expect(mal({ language: "fr" })).toBe(false)
    expect(mal({ partySize: 0 })).toBe(false)
    expect(mal({ deposit: { status: "pagada", amountCents: 0, checkoutSessionId: null } })).toBe(false)
    expect(mal({ customerId: "otro" })).toBe(false)
    expect(mal({})).toBe(true)
  })

  it("se prepara para escribir con el conversor de horas", () => {
    const r = ReservationSchema.parse(reservaDoc)
    const w = reservationForWrite(r, (ms) => ({ fromMillis: ms }))
    expect(w.startAt).toEqual({ fromMillis: MS })
    expect(w.history[0]?.at).toEqual({ fromMillis: MS - 3_600_000 })
    expect(w.guestName).toBe("Ana Puig")
    // Ida y vuelta: lo escrito se vuelve a leer igual.
    expect(ReservationSchema.parse(reservationForWrite(r, (ms) => new TimestampFalso(ms)))).toEqual(r)
  })
})

describe("señal", () => {
  it("por persona a partir de un tamaño de grupo", () => {
    const politica = { mode: "perPerson" as const, amountCents: 1000, fromPartySize: 6 }
    expect(depositAmountFor(politica, 5)).toBe(0)
    expect(depositAmountFor(politica, 6)).toBe(6000)
    expect(depositAmountFor({ ...politica, mode: "none" }, 10)).toBe(0)
  })
})

describe("cliente", () => {
  const cliente = {
    name: "Ana Puig",
    phone: "+34612345678",
    email: null,
    language: "es",
    visits: 3,
    noShows: 1,
    cancellations: 0,
    lastVisitAt: new Date(MS),
    notes: "Prefiere terraza",
    allergies: "Frutos secos",
    tags: ["habitual"],
    updatedBy: "uid-laura",
  }

  it("se lee con la última visita en ms o null", () => {
    expect(CustomerSchema.parse(cliente).lastVisitAt).toBe(MS)
    expect(CustomerSchema.parse({ ...cliente, lastVisitAt: null }).lastVisitAt).toBeNull()
    expect(CustomerSchema.safeParse({ ...cliente, visits: -1 }).success).toBe(false)
    expect(CustomerSchema.safeParse({ ...cliente, tags: ["x".repeat(31)] }).success).toBe(false)
    const { updatedBy: _sinEditor, ...sinEditor } = cliente
    expect(CustomerSchema.safeParse(sinEditor).success).toBe(true)
  })

  it("el personal solo edita notas, alergias y etiquetas", () => {
    expect(Object.keys(CustomerEditableSchema.shape).sort()).toEqual(["allergies", "notes", "tags"])
  })

  it("se prepara para escribir", () => {
    const c = CustomerSchema.parse(cliente)
    expect(customerForWrite(c, (ms) => `T${ms}`).lastVisitAt).toBe(`T${MS}`)
    expect(customerForWrite({ ...c, lastVisitAt: null }, (ms) => `T${ms}`).lastVisitAt).toBeNull()
  })
})

describe("lista de espera", () => {
  const entrada = {
    guestName: "Pau",
    phone: "+34699111222",
    email: null,
    language: "ca",
    partySize: 2,
    date: "2026-11-10",
    from: "20:30",
    to: "22:00",
    status: "offered",
    offer: { startAt: MS, expiresAt: MS + 30 * 60_000, tokenHash: sha256Hex("oferta") },
    customerId: customerIdFor("demo-lumbre", "+34699111222"),
    source: "widget",
  }

  it("se lee y se escribe", () => {
    const e = WaitlistEntrySchema.parse(entrada)
    expect(e.offer?.expiresAt).toBe(MS + 1_800_000)
    const w = waitlistEntryForWrite(e, (ms) => ms / 1000)
    expect(w.offer).toEqual({ startAt: MS / 1000, expiresAt: MS / 1000 + 1800, tokenHash: sha256Hex("oferta") })
    expect(waitlistEntryForWrite({ ...e, offer: null }, (ms) => ms).offer).toBeNull()
  })

  it("rechaza estados y fechas que no existen", () => {
    expect(WaitlistEntrySchema.safeParse({ ...entrada, status: "esperando" }).success).toBe(false)
    expect(WaitlistEntrySchema.safeParse({ ...entrada, date: "2026-02-30" }).success).toBe(false)
    expect(WaitlistEntrySchema.safeParse({ ...entrada, source: "phone" }).success).toBe(false)
  })
})

describe("mensaje", () => {
  const pedido = {
    channel: "whatsapp" as const,
    to: "+34612345678",
    template: "reminder" as const,
    language: "es" as const,
    data: { guestName: "Ana", partySize: 4, time: "21:00" },
    reservationId: "r1",
    waitlistId: null,
    sendAt: MS - 86_400_000,
  }

  it("un mensaje nuevo sale en cola y sin intentos", () => {
    const m = queuedMessage(MessageRequestSchema.parse(pedido))
    expect(m).toMatchObject({ status: "queued", attempts: 0, rendered: null, provider: null, lastError: null })
    expect(MessageSchema.parse(m)).toEqual(m)
    expect(messageForWrite(m, (ms) => new TimestampFalso(ms)).sendAt).toEqual(new TimestampFalso(MS - 86_400_000))
  })

  it("el destino tiene que cuadrar con el canal", () => {
    const base = queuedMessage(pedido)
    expect(MessageSchema.safeParse({ ...base, to: "ana@ejemplo.com" }).success).toBe(false)
    expect(MessageSchema.safeParse({ ...base, channel: "email", to: "ana@ejemplo.com" }).success).toBe(true)
    expect(MessageSchema.safeParse({ ...base, channel: "email" }).success).toBe(false)
  })

  it("lee un mensaje capturado en local con su texto", () => {
    const capturado = {
      ...queuedMessage(pedido),
      status: "captured",
      attempts: 1,
      provider: null,
      rendered: { subject: null, body: "Hola Ana, te esperamos mañana a las 21:00." },
      sendAt: new TimestampFalso(MS),
    }
    expect(MessageSchema.parse(capturado).rendered?.body).toContain("21:00")
    expect(MessageSchema.safeParse({ ...capturado, status: "enviado" }).success).toBe(false)
    expect(MessageSchema.safeParse({ ...capturado, data: { lista: [1, 2] } }).success).toBe(false)
  })
})

describe("restaurante público", () => {
  it("lleva lo justo para la página de reservas", () => {
    const pub = {
      restaurantId: "demo-lumbre",
      name: "Taberna Lumbre",
      brandColor: "#f0a35e",
      locale: "es",
      timezone: "Europe/Madrid",
      bookingEnabled: false,
      bookingDisabledReason: "public_booking_off",
      locations: [{ id: "centro", name: "Centro", address: "Carrer de la Lumbre 12", city: "Barcelona", phone: "+34 932 000 000" }],
      minPartySize: 1,
      maxPartySize: 12,
      maxAdvanceDays: 90,
      deposit: { mode: "none", amountCents: 0, fromPartySize: 1 },
      cancellationFreeUntilHours: 24,
    }
    expect(PublicRestaurantSchema.parse(pub)).toEqual(pub)
    expect(PublicRestaurantSchema.safeParse({ ...pub, bookingDisabledReason: "cerrado" }).success).toBe(false)
    expect(PublicRestaurantSchema.safeParse({ ...pub, brandColor: "naranja" }).success).toBe(false)
  })
})
