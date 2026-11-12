import { afterEach, describe, expect, it, vi } from "vitest"
import { ZodError } from "zod"
import type { FirebaseSettings } from "@/lib/firebase/config"
import { callableUrl, callPublic, PublicCallError } from "./callables"

const emulador: FirebaseSettings = {
  options: { projectId: "demo-llenamos", apiKey: "demo-api-key", appId: "demo" },
  region: "europe-west1",
  emulators: { host: "127.0.0.1", ports: { auth: 9106, firestore: 8100, functions: 5016, storage: 9216 } },
}
afterEach(() => vi.unstubAllEnvs())

function json(status: number, body: unknown) {
  return vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}

const disponibilidad = {
  date: "2026-11-12",
  partySize: 2,
  durationMinutes: 90,
  timezone: "Europe/Madrid",
  status: "open",
  message: null,
  slots: [{ time: "21:00", wallDate: "2026-11-12", startAt: Date.UTC(2026, 10, 12, 20), shift: "Cena", available: true, reason: null }],
  waitlistEnabled: true,
}

const reserva = {
  slug: "taberna-lumbre",
  locationId: "centro",
  date: "2026-11-12",
  time: "21:00",
  partySize: 2,
  guestName: "Clara Puig",
  phone: "612 34 56 78",
  email: "",
  language: "es" as const,
  acceptPolicy: true as const,
}

describe("callPublic", () => {
  it("usa el emulador y rechaza el backend Firebase productivo", () => {
    expect(callableUrl(emulador, "crearReservaPublica")).toBe("http://127.0.0.1:5016/demo-llenamos/europe-west1/crearReservaPublica")
    expect(() => callableUrl({ ...emulador, emulators: null, options: { projectId: "llenamos" } }, "x")).toThrow("servidor de datos")
  })

  it("envía { data } ya validado y devuelve el resultado validado", async () => {
    const fetcher = json(200, { result: disponibilidad })
    const out = await callPublic(emulador, "consultarDisponibilidad", { slug: "taberna-lumbre", locationId: "centro", date: "2026-11-12", partySize: 2 }, { fetcher })
    expect(out.slots[0]?.time).toBe("21:00")
    const init = fetcher.mock.calls[0]?.[1]
    expect(init?.method).toBe("POST")
    expect(JSON.parse(String(init?.body))).toEqual({ data: { slug: "taberna-lumbre", locationId: "centro", date: "2026-11-12", partySize: 2 } })
  })

  it("normaliza el teléfono y pone el campo trampa vacío antes de enviar", async () => {
    const fetcher = json(200, { result: {} })
    await callPublic(emulador, "crearReservaPublica", reserva, { fetcher }).catch(() => undefined)
    const sent = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).data
    expect(sent.phone).toBe("+34612345678")
    expect(sent.email).toBeNull()
    expect(sent.website).toBe("")
    expect(sent.source).toBe("web")
  })

  it("no llama al servidor si la entrada no vale", async () => {
    const fetcher = json(200, { result: {} })
    await expect(callPublic(emulador, "crearReservaPublica", { ...reserva, phone: "123" }, { fetcher })).rejects.toBeInstanceOf(ZodError)
    await expect(callPublic(emulador, "crearReservaPublica", { ...reserva, website: "http://spam" }, { fetcher })).rejects.toBeInstanceOf(ZodError)
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("convierte el error de la callable en código y mensaje", async () => {
    const fetcher = json(400, { error: { status: "FAILED_PRECONDITION", message: "Esa franja ya no está disponible." } })
    const error = await callPublic(emulador, "crearReservaPublica", reserva, { fetcher }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(PublicCallError)
    expect(error).toMatchObject({ code: "failed-precondition", message: "Esa franja ya no está disponible." })
  })

  it("distingue una función sin desplegar, la red caída y una respuesta que no encaja", async () => {
    const sinFuncion = vi.fn(async () => new Response("Not Found", { status: 404 }))
    await expect(callPublic(emulador, "iniciarPagoSenal", { slug: "a", reference: "K7Q2MD", token: "a".repeat(43) }, { fetcher: sinFuncion })).rejects.toMatchObject({ code: "not-deployed" })

    const caida = vi.fn(async () => {
      throw new TypeError("Failed to fetch")
    })
    await expect(callPublic(emulador, "crearReservaPublica", reserva, { fetcher: caida })).rejects.toMatchObject({ code: "network" })

    const rara = json(200, { result: { reference: "no" } })
    await expect(callPublic(emulador, "crearReservaPublica", reserva, { fetcher: rara })).rejects.toMatchObject({ code: "internal" })
  })

  it("corta si el servidor tarda demasiado", async () => {
    const lenta = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")))),
    )
    await expect(callPublic(emulador, "crearReservaPublica", reserva, { fetcher: lenta, timeoutMs: 10 })).rejects.toMatchObject({ code: "deadline-exceeded" })
  })

  it("valida las salidas de R2 con los esquemas de core", async () => {
    const pago = json(200, { result: { status: "not_configured", message: "Los pagos de señal no están configurados." } })
    const out = await callPublic(emulador, "iniciarPagoSenal", { slug: "taberna-lumbre", reference: "k7q-2md", token: "a".repeat(43) }, { fetcher: pago })
    expect(out).toEqual({ status: "not_configured", message: "Los pagos de señal no están configurados." })
    expect(JSON.parse(String(pago.mock.calls[0]?.[1]?.body)).data.reference).toBe("K7Q2MD")

    const espera = json(200, { result: { waitlistId: "w1", status: "waiting" } })
    const apuntado = await callPublic(
      emulador,
      "apuntarseListaEspera",
      { slug: "taberna-lumbre", locationId: "centro", date: "2026-11-12", from: "20:00", to: "22:00", partySize: 2, guestName: "Clara", phone: "612345678", language: "ca" },
      { fetcher: espera },
    )
    expect(apuntado.status).toBe("waiting")
  })
  it("PostgreSQL público no necesita sesión ni configuración Firebase y conserva Zod", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    const fetcher = json(200, { result: disponibilidad })
    const result = await callPublic(null, "consultarDisponibilidad", { slug: "taberna-lumbre", locationId: "centro", date: "2026-11-12", partySize: 2 }, { fetcher })
    expect(result.slots[0]?.time).toBe("21:00")
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/operations/consultarDisponibilidad")
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty("Authorization")
    expect(fetcher.mock.calls[0]?.[1]?.redirect).toBe("error")
  })
})
