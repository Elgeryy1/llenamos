import { describe, expect, it } from "vitest"
import { validarEntradaCore } from "@/lib/data/callables"
import {
  cambiarPlanInput,
  choicesFromOverrides,
  draftFrom,
  isDirty,
  isLogiqdTeam,
  matchesRestaurant,
  moduleDiff,
  overridesFromChoices,
  planStateOf,
  previewModules,
} from "./planes"

describe("claim del equipo", () => {
  it("solo con logiqd: true", () => {
    expect(isLogiqdTeam({ logiqd: true })).toBe(true)
    expect(isLogiqdTeam({ logiqd: "true" })).toBe(false)
    expect(isLogiqdTeam({})).toBe(false)
    expect(isLogiqdTeam(null)).toBe(false)
  })
})

describe("plan y excepciones", () => {
  it("lee las excepciones guardadas", () => {
    expect(choicesFromOverrides({ repite: true, kitchen: false })).toEqual({
      reservations: "plan",
      floor: "plan",
      kitchen: "off",
      pos: "plan",
      repite: "on",
      staff: "plan",
      inventory: "plan",
      loyalty: "plan",
      marketing: "plan",
      analytics: "plan",
    })
  })

  it("no guarda excepciones que no cambian nada", () => {
    const choices = { reservations: "on", floor: "off", kitchen: "plan", pos: "on", repite: "plan", staff: "plan", inventory: "plan", loyalty: "plan", marketing: "plan", analytics: "plan" } as const
    expect(overridesFromChoices("sala", choices)).toEqual({ floor: false, pos: true })
  })

  it("vista previa de los módulos", () => {
    const d = { plan: "reservas" as const, choices: choicesFromOverrides({ repite: true }) }
    expect(previewModules(d)).toEqual(["reservations", "repite"])
  })

  it("estado de un restaurante sin plan: completo y pendiente de migrar", () => {
    const s = planStateOf({})
    expect(s).toMatchObject({ plan: "completo", legacy: true })
    expect(s.active).toEqual(["reservations", "floor", "kitchen", "pos", "repite", "staff", "inventory", "loyalty", "marketing", "analytics"])
    expect(isDirty(s, draftFrom(s))).toBe(true)
  })

  it("sabe si hay cambios", () => {
    const s = planStateOf({ plan: "sala", moduleOverrides: {}, activeModules: ["reservations", "floor", "kitchen"] })
    const d = draftFrom(s)
    expect(isDirty(s, d)).toBe(false)
    expect(isDirty(s, { ...d, plan: "completo" })).toBe(true)
    expect(isDirty(s, { ...d, choices: { ...d.choices, floor: "on" } })).toBe(false)
    expect(isDirty(s, { ...d, choices: { ...d.choices, floor: "off" } })).toBe(true)
  })

  it("qué se enciende y qué se apaga", () => {
    expect(moduleDiff(["reservations", "floor"], ["reservations", "pos"])).toEqual({ on: ["pos"], off: ["floor"] })
  })

  it("prepara la entrada de cambiarPlan con el esquema de core", () => {
    const input = cambiarPlanInput("demo-lumbre", { plan: "sala", choices: choicesFromOverrides({ reservations: false }) })
    expect(input).toEqual({ restaurantId: "demo-lumbre", plan: "sala", moduleOverrides: { reservations: false } })
    expect(validarEntradaCore("cambiarPlan", input)).toEqual(input)
    expect(() => validarEntradaCore("cambiarPlan", { restaurantId: "x", plan: "oro" as never })).toThrow()
  })

  it("busca restaurantes sin tildes", () => {
    const r = { id: "demo-lumbre", name: "Taberna Lumbre", slug: "taberna-lumbre" }
    expect(matchesRestaurant(r, "lumbre")).toBe(true)
    expect(matchesRestaurant(r, "TABERNA")).toBe(true)
    expect(matchesRestaurant({ ...r, name: "Café Ñu" }, "cafe")).toBe(true)
    expect(matchesRestaurant(r, "otro")).toBe(false)
  })
})

describe("lista del equipo", () => {
  it("un restaurante roto sale como fila con error", async () => {
    const { parseRestaurant } = await import("@/lib/data/parse")
    const { parseTeamRestaurant } = await import("./planes")
    const bien = parseTeamRestaurant(
      "demo-lumbre",
      { name: "Taberna Lumbre", slug: "taberna-lumbre", brandColor: "#f0a35e", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: true },
      parseRestaurant,
    )
    expect(bien.ok).toBe(true)
    const mal = parseTeamRestaurant("roto", { name: 3 }, parseRestaurant)
    expect(mal).toMatchObject({ ok: false, id: "roto" })
  })
})
