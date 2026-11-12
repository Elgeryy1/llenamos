import { queuedMessage, type Message } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import { DataShapeError } from "@/lib/data/parse"
import {
  countByFilter,
  dueCount,
  filterInbox,
  guestOf,
  messageTitle,
  parseMessage,
  processSummary,
  statusExplanation,
  statusLabel,
  statusTone,
  type MessageDoc,
} from "./bandeja"

const NOW = Date.UTC(2026, 10, 9, 12, 0)

function msg(id: string, over: Partial<Message> = {}): MessageDoc {
  return {
    id,
    ...queuedMessage({
      channel: "email",
      to: "ana@example.com",
      template: "confirmation",
      language: "es",
      data: { guestName: "Ana García", reference: "K7M2QX" },
      reservationId: "r1",
      waitlistId: null,
      sendAt: NOW - 60_000,
    }),
    ...over,
  }
}

const bandeja: MessageDoc[] = [
  msg("a", { status: "captured", rendered: { subject: "Reserva confirmada", body: "Hola Ana, te esperamos el martes." } }),
  msg("b", { channel: "whatsapp", to: "+34600111222", template: "reminder", sendAt: NOW + 3_600_000, data: { guestName: "Joan Puig" } }),
  msg("c", { status: "failed", attempts: 3, lastError: "Correo rebotado", sendAt: NOW - 120_000 }),
  msg("d", { status: "not_configured", channel: "whatsapp", to: "+34600999888" }),
  msg("e", { status: "cancelled", template: "reminder" }),
  msg("f", { sendAt: NOW - 1000 }),
]

describe("lectura", () => {
  it("lee un mensaje con la hora como Timestamp", () => {
    const data = { ...msg("x"), sendAt: { seconds: NOW / 1000, nanoseconds: 0 } }
    expect(parseMessage("x", data).sendAt).toBe(NOW)
  })

  it("un mensaje que no encaja dice qué campos fallan", () => {
    expect(() => parseMessage("x", { ...msg("x"), channel: "fax" })).toThrow(DataShapeError)
    try {
      parseMessage("x", { ...msg("x"), channel: "whatsapp" })
    } catch (e) {
      expect((e as DataShapeError).fields).toEqual(["to"])
    }
  })
})

describe("filtros", () => {
  it("cuenta por grupo", () => {
    expect(countByFilter(bandeja)).toEqual({ all: 6, queued: 2, sent: 0, captured: 1, problems: 2, cancelled: 1 })
  })

  it("con problemas agrupa fallidos y sin canal", () => {
    expect(filterInbox(bandeja, { filter: "problems", channel: "all", text: "" }).map((m) => m.id)).toEqual(["d", "c"])
  })

  it("por canal y por texto, sin tildes ni mayúsculas", () => {
    expect(filterInbox(bandeja, { filter: "all", channel: "whatsapp", text: "" }).map((m) => m.id)).toEqual(["b", "d"])
    expect(filterInbox(bandeja, { filter: "all", channel: "all", text: "JOAN" }).map((m) => m.id)).toEqual(["b"])
    expect(filterInbox(bandeja, { filter: "all", channel: "all", text: "esperamos" }).map((m) => m.id)).toEqual(["a"])
    expect(filterInbox(bandeja, { filter: "all", channel: "all", text: "garcia" })).toHaveLength(5)
  })

  it("lo más reciente primero", () => {
    expect(filterInbox(bandeja, { filter: "queued", channel: "all", text: "" }).map((m) => m.id)).toEqual(["b", "f"])
  })

  it("pendientes que ya deberían haber salido", () => {
    expect(dueCount(bandeja, NOW)).toBe(1)
  })
})

describe("textos", () => {
  it("cada estado con su palabra y su tono", () => {
    expect(statusLabel("captured")).toBe("no enviado: modo local")
    expect(statusTone("captured")).toBe("local")
    expect(statusTone("failed")).toBe("error")
    expect(statusTone("sent")).toBe("ok")
  })

  it("título del mensaje", () => {
    expect(messageTitle({ template: "reminder", channel: "whatsapp" })).toBe("Recordatorio por WhatsApp")
    expect(messageTitle({ template: "confirmation", channel: "email" })).toBe("Confirmación por correo")
  })

  it("explica cada estado", () => {
    expect(statusExplanation(msg("a", { status: "failed", attempts: 1, lastError: "Sin saldo" }), NOW)).toBe(
      "Ha fallado tras 1 intento: Sin saldo",
    )
    expect(statusExplanation(msg("a"), NOW)).toContain("Procesar pendientes")
    expect(statusExplanation(msg("a", { sendAt: NOW + 1 }), NOW)).toBe("Está programado y saldrá solo a su hora.")
  })

  it("nombre del cliente si lo hay", () => {
    expect(guestOf(msg("a"))).toBe("Ana García")
    expect(guestOf(msg("a", { data: {} }))).toBeNull()
  })

  it("resumen de procesar pendientes", () => {
    expect(processSummary({ processed: 0, sent: 0, captured: 0, notConfigured: 0, failed: 0 })).toBe("No había mensajes pendientes de enviar.")
    expect(processSummary({ processed: 3, sent: 0, captured: 2, notConfigured: 1, failed: 0 })).toBe(
      "3 mensajes procesados: 2 capturados en local, 1 sin canal configurado.",
    )
  })
})
