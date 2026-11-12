import { describe, expect, it, vi } from "vitest"
import type { FirebaseSettings } from "@/lib/firebase/config"
import { fetchPublicRestaurantFromApi } from "./restaurante"
import { decodeFields, documentUrl, fetchPublicRestaurant } from "./restaurante-demo"

const emulador: FirebaseSettings = {
  options: { projectId: "demo-llenamos", apiKey: "demo-api-key", appId: "demo" },
  region: "europe-west1",
  emulators: { host: "127.0.0.1", ports: { auth: 9106, firestore: 8100, functions: 5016, storage: 9216 } },
}
const nube: FirebaseSettings = { ...emulador, options: { ...emulador.options, projectId: "llenamos" }, emulators: null }

/** Documento tal y como lo devuelve la API REST de Firestore. */
const documento = {
  name: "projects/demo-llenamos/databases/(default)/documents/publicRestaurants/taberna-lumbre",
  fields: {
    restaurantId: { stringValue: "demo-lumbre" },
    name: { stringValue: "Taberna Lumbre" },
    brandColor: { stringValue: "#f0a35e" },
    locale: { stringValue: "es" },
    timezone: { stringValue: "Europe/Madrid" },
    bookingEnabled: { booleanValue: true },
    bookingDisabledReason: { nullValue: null },
    locations: {
      arrayValue: {
        values: [
          {
            mapValue: {
              fields: {
                id: { stringValue: "centro" },
                name: { stringValue: "Centro" },
                address: { stringValue: "Carrer de la Lumbre 12" },
                city: { stringValue: "Barcelona" },
                phone: { stringValue: "" },
              },
            },
          },
        ],
      },
    },
    minPartySize: { integerValue: "1" },
    maxPartySize: { integerValue: "8" },
    maxAdvanceDays: { integerValue: "60" },
    deposit: { mapValue: { fields: { mode: { stringValue: "none" }, amountCents: { integerValue: "0" }, fromPartySize: { integerValue: "1" } } } },
    cancellationFreeUntilHours: { integerValue: "24" },
    createdAt: { timestampValue: "2026-11-09T10:00:00.000Z" },
  },
}

function respuesta(status: number, body: unknown) {
  return vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }))
}

describe("API REST de Firestore", () => {
  it("convierte los valores en datos normales", () => {
    expect(
      decodeFields({
        a: { integerValue: "42" },
        b: { doubleValue: 1.5 },
        c: { timestampValue: "2026-11-09T10:00:00Z" },
        d: { arrayValue: {} },
        e: { mapValue: { fields: { f: { booleanValue: false } } } },
      }),
    ).toEqual({ a: 42, b: 1.5, c: Date.UTC(2026, 10, 9, 10), d: [], e: { f: false } })
  })

  it("apunta al emulador en local y a Firestore con la clave fuera", () => {
    expect(documentUrl(emulador, "publicRestaurants/x")).toBe(
      "http://127.0.0.1:8100/v1/projects/demo-llenamos/databases/(default)/documents/publicRestaurants/x",
    )
    expect(documentUrl(nube, "publicRestaurants/x")).toBe(
      "https://firestore.googleapis.com/v1/projects/llenamos/databases/(default)/documents/publicRestaurants/x?key=demo-api-key",
    )
  })
})

describe("fetchPublicRestaurant", () => {
  it("lee y valida el restaurante con el esquema de core", async () => {
    const fetcher = respuesta(200, documento)
    const r = await fetchPublicRestaurant("taberna-lumbre", emulador, fetcher)
    expect(r.status).toBe("ok")
    if (r.status !== "ok") return
    expect(r.restaurant.name).toBe("Taberna Lumbre")
    expect(r.restaurant.locations[0]?.id).toBe("centro")
    expect(r.restaurant.maxPartySize).toBe(8)
    expect(r.restaurant).not.toHaveProperty("createdAt")
  })

  it("dice que no existe con un 404 o con un slug imposible, sin llamar", async () => {
    expect(await fetchPublicRestaurant("no-existe", emulador, respuesta(404, { error: {} }))).toEqual({ status: "not_found" })
    const fetcher = respuesta(200, documento)
    expect(await fetchPublicRestaurant("../restaurants", emulador, fetcher)).toEqual({ status: "not_found" })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("no rellena nada si el documento no encaja: dice qué falla", async () => {
    const roto = { fields: { ...documento.fields, bookingEnabled: { stringValue: "sí" } } }
    const r = await fetchPublicRestaurant("taberna-lumbre", emulador, respuesta(200, roto))
    expect(r.status).toBe("invalid")
    if (r.status === "invalid") expect(r.problems.join(" ")).toContain("bookingEnabled")
  })

  it("avisa si Firestore no responde o falta la configuración", async () => {
    const caido = vi.fn(async () => {
      throw new TypeError("fetch failed")
    })
    expect((await fetchPublicRestaurant("taberna-lumbre", emulador, caido)).status).toBe("unavailable")
    expect((await fetchPublicRestaurant("taberna-lumbre", emulador, respuesta(503, {}))).status).toBe("unavailable")
    expect((await fetchPublicRestaurant("taberna-lumbre", null)).status).toBe("unavailable")
  })
})

describe("proyección pública desde la API del VPS", () => {
  const restaurant = {
    restaurantId: "r1", name: "Taberna", brandColor: "#112233", locale: "es", timezone: "Europe/Madrid", bookingEnabled: true, bookingDisabledReason: null,
    locations: [{ id: "centro", name: "Centro", address: "", city: "", phone: "" }], minPartySize: 1, maxPartySize: 10, maxAdvanceDays: 60,
    deposit: { mode: "none", amountCents: 0, fromPartySize: 1 }, cancellationFreeUntilHours: 0,
  }
  it("pide solo el slug por la red interna y valida la respuesta", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: restaurant }), { status: 200 }))
    const result = await fetchPublicRestaurantFromApi("taberna", "http://api:3100", fetcher)
    expect(result).toMatchObject({ status: "ok", restaurant: { name: "Taberna" } })
    expect(fetcher).toHaveBeenCalledWith("http://api:3100/v1/operations/verRestaurantePublico", expect.objectContaining({ method: "POST", body: JSON.stringify({ data: { slug: "taberna" } }) }))
  })
  it("distingue no encontrado, API caída, contrato roto y origen sin configurar", async () => {
    expect(await fetchPublicRestaurantFromApi("taberna", "http://api:3100", vi.fn<typeof fetch>(async () => new Response("{}", { status: 404 })))).toEqual({ status: "not_found" })
    expect(await fetchPublicRestaurantFromApi("taberna", "http://api:3100", vi.fn<typeof fetch>(async () => { throw new Error("red") }))).toMatchObject({ status: "unavailable" })
    expect(await fetchPublicRestaurantFromApi("taberna", "http://api:3100", vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: { name: "x" } }), { status: 200 })))).toMatchObject({ status: "invalid" })
    expect(await fetchPublicRestaurantFromApi("taberna", undefined, vi.fn<typeof fetch>())).toMatchObject({ status: "unavailable" })
    expect(await fetchPublicRestaurantFromApi("No Valido", "http://api:3100", vi.fn<typeof fetch>())).toEqual({ status: "not_found" })
  })
})
