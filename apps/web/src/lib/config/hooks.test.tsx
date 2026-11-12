import { renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { defaultReservationSettings } from "@llenamos/core"

const mocks = vi.hoisted(() => ({ doc: vi.fn<(...args: unknown[]) => { status: string }>(() => ({ status: "loading" })), query: vi.fn<(...args: unknown[]) => { status: string }>(() => ({ status: "loading" })) }))
vi.mock("@/lib/data/demo-live", () => ({ useDemoDoc: mocks.doc, useDemoQuery: mocks.query }))
vi.mock("@/lib/firebase/auth-client", () => ({ identityToken: async () => "token-de-prueba" }))
import { useMessages, usePublicRestaurant, useReservationSettings } from "./hooks"
import { cancelIdentityRequests } from "@/lib/api/transport"

const stream = (frame: string) => vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frame)) } }), { status: 200 }))
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); mocks.doc.mockClear(); mocks.query.mockClear() })
afterEach(() => { cancelIdentityRequests(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })
describe("ganchos de configuración en el VPS", () => {
  it("lee ajustes de reservas por la lectura en vivo y no abre ningún listener de Firestore", async () => {
    const fetcher = stream(`id: 1\nevent: snapshot\ndata: ${JSON.stringify({ settings: defaultReservationSettings(), saved: false })}\n\n`)
    vi.stubGlobal("fetch", fetcher)
    const { result } = renderHook(() => useReservationSettings("r1", "centro"))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/live/ajustesReservas")
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ data: { restaurantId: "r1", locationId: "centro" } })
    expect(mocks.doc).toHaveBeenCalledWith(null, expect.any(Function))
  })
  it("los avisos salen de la lectura mensajesRecientes y se desenvuelven", async () => {
    const message = { id: "m1", channel: "email", to: "ana@example.test", template: "confirmation", language: "es", data: {}, reservationId: "res1", waitlistId: null, status: "sent", sendAt: 1, attempts: 1, lastError: null, provider: "resend", providerMessageId: null, rendered: null }
    const fetcher = stream(`id: 1\nevent: snapshot\ndata: ${JSON.stringify({ messages: [message] })}\n\n`)
    vi.stubGlobal("fetch", fetcher)
    const { result } = renderHook(() => useMessages("r1", 25))
    await waitFor(() => expect(result.current.status).toBe("ready"))
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/live/mensajesRecientes")
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ data: { restaurantId: "r1", limit: 25 } })
    expect(result.current).toMatchObject({ data: [{ id: "m1", status: "sent" }] })
    expect(mocks.query.mock.calls.every(call => call[0] === null)).toBe(true)
  })
  it("un fallo del servidor se enseña y no se rellena con datos", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "not-deployed", message: "x" } }), { status: 404 })))
    const messages = renderHook(() => useMessages("r1", 50))
    await waitFor(() => expect(messages.result.current).toMatchObject({ status: "error", error: { code: "not-deployed" } }))
  })
  it("la ficha pública sale de verRestaurantePublico sin identidad", async () => {
    const restaurant = { restaurantId: "r1", name: "La Taberna", brandColor: "#b45309", locale: "es", timezone: "Europe/Madrid", bookingEnabled: true, bookingDisabledReason: null, locations: [], minPartySize: 1, maxPartySize: 10, maxAdvanceDays: 60, deposit: { mode: "none", amountCents: 0, fromPartySize: 1 }, cancellationFreeUntilHours: 24 }
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: restaurant }), { status: 200 }))
    vi.stubGlobal("fetch", fetcher)
    const { result } = renderHook(() => usePublicRestaurant("taberna"))
    await waitFor(() => expect(result.current.status).not.toBe("loading"))
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/operations/verRestaurantePublico")
    expect((fetcher.mock.calls[0]?.[1]?.headers as Record<string, string>)?.Authorization).toBeUndefined()
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ data: { slug: "taberna" } })
    expect(result.current).toMatchObject({ status: "ready", data: { name: "La Taberna" } })
  })
  it("desactivado no abre conexión", () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    renderHook(() => useMessages("r1", 50, false))
    renderHook(() => useReservationSettings("r1", null))
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("en la demo usa Firestore y nunca la API", () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    renderHook(() => useReservationSettings("r1", "centro"))
    renderHook(() => useMessages("r1", 50))
    expect(mocks.doc.mock.calls[0]?.[0]).toBe("restaurants/r1/locations/centro/settings/reservations")
    expect(mocks.query.mock.calls[0]?.[0]).toEqual({ path: "restaurants/r1/messages", orderBy: ["sendAt", "desc"], limit: 50 })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
