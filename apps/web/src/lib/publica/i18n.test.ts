import { LANGUAGES } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import { DICTIONARIES, interpolate, pickLanguage, shiftLabel, translator, type TextKey } from "./i18n"

const keys = Object.keys(DICTIONARIES.es) as TextKey[]

describe("diccionarios", () => {
  it("los tres idiomas tienen las mismas claves y ningún texto vacío", () => {
    for (const lang of LANGUAGES) {
      expect(Object.keys(DICTIONARIES[lang]).sort()).toEqual([...keys].sort())
      for (const key of keys) expect(DICTIONARIES[lang][key].trim(), `${lang}.${key}`).not.toBe("")
    }
  })

  it("usan las mismas variables en cada idioma", () => {
    const vars = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort()
    for (const key of keys) {
      for (const lang of LANGUAGES) expect(vars(DICTIONARIES[lang][key]), `${lang}.${key}`).toEqual(vars(DICTIONARIES.es[key]))
    }
  })

  it("no llevan guiones dentro de las frases", () => {
    for (const lang of LANGUAGES) {
      for (const key of keys) expect(DICTIONARIES[lang][key], `${lang}.${key}`).not.toMatch(/\s[-–—]\s|—|–/)
    }
  })

  it("no ponen mayúscula en cada palabra (salvo nombres de idioma)", () => {
    for (const lang of LANGUAGES) {
      for (const key of keys) {
        const words = DICTIONARIES[lang][key].split(/\s+/).filter((w) => /^\p{L}/u.test(w) && !w.startsWith("{"))
        if (words.length < 3) continue
        const capitalised = words.filter((w) => /^\p{Lu}/u.test(w)).length
        expect(capitalised / words.length, `${lang}.${key}`).toBeLessThan(0.5)
      }
    }
  })
})

describe("traducir", () => {
  it("sustituye variables y deja a la vista las que faltan", () => {
    expect(interpolate("Tienes mesa, {name}", { name: "Clara" })).toBe("Tienes mesa, Clara")
    expect(interpolate("{a} y {b}", { a: 1 })).toBe("1 y {b}")
    expect(translator("ca")("confirmedTitle", { name: "Pau" })).toBe("Tens taula, Pau")
    expect(translator("en")("peopleMany", { n: 4 })).toBe("4 guests")
  })

  it("elige el idioma del enlace si es válido y si no el del restaurante", () => {
    expect(pickLanguage("ca", "es")).toBe("ca")
    expect(pickLanguage(["EN"], "es")).toBe("en")
    expect(pickLanguage("en-GB", "ca")).toBe("en")
    expect(pickLanguage("fr", "ca")).toBe("ca")
    expect(pickLanguage(undefined, "es")).toBe("es")
  })

  it("traduce los turnos habituales y deja los demás como los escribió el restaurante", () => {
    expect(shiftLabel("Comida", "ca")).toBe("Dinar")
    expect(shiftLabel("cena", "en")).toBe("Dinner")
    expect(shiftLabel("Mediodía", "en")).toBe("Lunch")
    expect(shiftLabel("Vermut", "en")).toBe("Vermut")
  })
})
