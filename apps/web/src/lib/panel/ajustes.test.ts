import { describe, expect, it } from "vitest"
import { fieldErrors, temporaryPassword } from "@/lib/forms"
import { AjustesSchema, changedFields, isLightColor, normalizeHex } from "./ajustes"

const saved = { name: "Taberna Lumbre", brandColor: "#f0a35e", locale: "es" as const }

describe("changedFields", () => {
  it("solo devuelve lo que ha cambiado", () => {
    expect(changedFields(saved, saved)).toEqual({})
    expect(changedFields(saved, { ...saved, name: " Taberna Lumbre " })).toEqual({})
    expect(changedFields(saved, { ...saved, brandColor: "#F0A35E" })).toEqual({})
    expect(changedFields(saved, { ...saved, locale: "ca", name: "Lumbre" })).toEqual({ locale: "ca", name: "Lumbre" })
  })
})

describe("AjustesSchema", () => {
  it("rechaza colores y idiomas que no son del contrato", () => {
    const r = AjustesSchema.safeParse({ name: "X", brandColor: "rojo", locale: "fr" })
    expect(r.success).toBe(false)
    if (!r.success) expect(Object.keys(fieldErrors(r.error, ["name", "brandColor", "locale"]))).toEqual(["name", "brandColor", "locale"])
  })
})

describe("normalizeHex", () => {
  it("acepta formas habituales de escribir un color", () => {
    expect(normalizeHex("F0A35E")).toBe("#f0a35e")
    expect(normalizeHex(" #f0a ")).toBe("#ff00aa")
    expect(normalizeHex("#12345")).toBeNull()
    expect(normalizeHex("naranja")).toBeNull()
  })
})

describe("isLightColor", () => {
  it("distingue colores claros y oscuros", () => {
    expect(isLightColor("#f0a35e")).toBe(true)
    expect(isLightColor("#131209")).toBe(false)
  })
})

describe("temporaryPassword", () => {
  it("genera contraseñas largas sin letras que se confunden", () => {
    const p = temporaryPassword()
    expect(p).toHaveLength(12)
    expect(p).not.toMatch(/[l1O0Ii]/)
    expect(temporaryPassword()).not.toBe(p)
  })
})
