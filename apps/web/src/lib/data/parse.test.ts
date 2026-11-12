import { describe, expect, it } from "vitest"
import { DataShapeError, parseActivity, parseMember, parseRestaurant, parseTable, parseUserProfile } from "./parse"

describe("parseUserProfile", () => {
  it("un perfil que aún no existe no tiene restaurantes", () => {
    expect(parseUserProfile("u1", undefined)).toEqual({ displayName: null, restaurants: [] })
  })

  it("convierte el mapa de restaurantes en una lista ordenada por nombre", () => {
    const p = parseUserProfile("u1", {
      displayName: "Marta",
      email: "m@x.test",
      restaurants: { b: { name: "Taberna Lumbre", role: "owner" }, a: { name: "Brasa", role: "waiter" } },
    })
    expect(p.restaurants).toEqual([
      { id: "a", name: "Brasa", role: "waiter" },
      { id: "b", name: "Taberna Lumbre", role: "owner" },
    ])
  })

  it("rechaza un rol que no existe", () => {
    expect(() => parseUserProfile("u1", { restaurants: { a: { name: "X", role: "jefe" } } })).toThrow(DataShapeError)
  })
})

describe("parseRestaurant", () => {
  const ok = {
    name: "Taberna Lumbre",
    slug: "taberna-lumbre",
    brandColor: "#f0a35e",
    currency: "EUR",
    timezone: "Europe/Madrid",
    locale: "es",
    isDemo: true,
    createdAt: {},
  }

  it("lee un restaurante del contrato y descarta campos que no conoce", () => {
    expect(parseRestaurant("demo-lumbre", ok)).toEqual({
      id: "demo-lumbre",
      name: "Taberna Lumbre",
      slug: "taberna-lumbre",
      brandColor: "#f0a35e",
      currency: "EUR",
      timezone: "Europe/Madrid",
      locale: "es",
      isDemo: true,
    })
  })

  it("dice qué campos están mal en vez de inventarlos", () => {
    try {
      parseRestaurant("r", { ...ok, brandColor: "naranja", locale: undefined })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(DataShapeError)
      expect((e as DataShapeError).fields).toEqual(["brandColor", "locale"])
      expect((e as Error).message).toContain("restaurants/r")
    }
  })
})

describe("parseMember y parseTable", () => {
  it("un miembro que no existe es null", () => {
    expect(parseMember("u", undefined)).toBeNull()
  })

  it("valida la mesa con el esquema de core", () => {
    const table = { name: "S1", areaId: "sala", seats: 4, shape: "round", x: 1, y: 2, w: 10, h: 10, joinableWith: [], enabled: true }
    expect(parseTable("s1", table).id).toBe("s1")
    expect(() => parseTable("s1", { ...table, seats: 0 })).toThrow(DataShapeError)
  })
})

describe("parseActivity", () => {
  it("convierte la marca de tiempo en Date", () => {
    const date = new Date("2026-11-09T10:00:00Z")
    const a = parseActivity("x", {
      action: "member.invited",
      summary: "Marta ha invitado a Laia",
      actorUid: "u",
      actorName: "Marta",
      entity: { type: "member", id: "l" },
      createdAt: { toDate: () => date },
    })
    expect(a.createdAt).toEqual(date)
    expect(a.entity).toEqual({ type: "member", id: "l" })
  })

  it("acepta entradas del sistema sin autor ni fecha", () => {
    const a = parseActivity("x", { action: "a", summary: "s", actorUid: null, actorName: null, entity: null })
    expect(a.createdAt).toBeNull()
  })
})
