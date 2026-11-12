import type { PublicRestaurant } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import {
  bookingState,
  bookingUrl,
  parsePublicRestaurant,
  siteOrigin,
  widgetFrameUrl,
  widgetIframeSnippet,
  widgetScriptSnippet,
} from "./enlaces"

const pub: PublicRestaurant = {
  restaurantId: "demo-lumbre",
  name: "Taberna Lumbre",
  brandColor: "#f0a35e",
  locale: "es",
  timezone: "Europe/Madrid",
  bookingEnabled: true,
  bookingDisabledReason: null,
  locations: [{ id: "centro", name: "Centro", address: "Carrer de la Lumbre 12", city: "Barcelona", phone: "" }],
  minPartySize: 1,
  maxPartySize: 12,
  maxAdvanceDays: 90,
  deposit: { mode: "none", amountCents: 0, fromPartySize: 1 },
  cancellationFreeUntilHours: 0,
}

describe("enlaces", () => {
  it("el origen sale de la variable o del navegador, sin barra final", () => {
    expect(siteOrigin(undefined, "http://localhost:3012")).toBe("http://localhost:3012")
    expect(siteOrigin("https://llenamos.logiqd.me/", "http://localhost:3012")).toBe("https://llenamos.logiqd.me")
    expect(siteOrigin("  ", "http://localhost:3012/")).toBe("http://localhost:3012")
  })

  it("enlace público y del widget", () => {
    expect(bookingUrl("https://x.test", "taberna-lumbre")).toBe("https://x.test/r/taberna-lumbre")
    expect(widgetFrameUrl("https://x.test", "taberna-lumbre")).toBe("https://x.test/widget/taberna-lumbre")
  })

  it("código del script", () => {
    expect(widgetScriptSnippet("https://x.test", "taberna-lumbre")).toBe(
      '<script src="https://x.test/widget.js" data-llenamos-slug="taberna-lumbre" async></script>',
    )
    expect(() => widgetScriptSnippet("https://x.test", '"><script>')).toThrow()
  })

  it("código del iframe con el nombre escapado", () => {
    const code = widgetIframeSnippet("https://x.test", "taberna-lumbre", 'Casa "Pepe" & <hijos>')
    expect(code).toContain('src="https://x.test/widget/taberna-lumbre"')
    expect(code).toContain('title="Reservar en Casa &quot;Pepe&quot; &amp; &lt;hijos&gt;"')
  })
})

describe("estado de la página pública", () => {
  it("lee el documento público", () => {
    expect(parsePublicRestaurant("taberna-lumbre", pub)).toEqual(pub)
    expect(parsePublicRestaurant("taberna-lumbre", undefined)).toBeNull()
    expect(() => parsePublicRestaurant("taberna-lumbre", { ...pub, bookingEnabled: "sí" })).toThrow()
  })

  it("dice por qué no acepta reservas", () => {
    expect(bookingState(pub)).toEqual({ kind: "open" })
    expect(bookingState(null)).toEqual({ kind: "missing" })
    expect(bookingState({ ...pub, bookingEnabled: false, bookingDisabledReason: "module_off" })).toEqual({ kind: "module_off" })
    expect(bookingState({ ...pub, bookingEnabled: false, bookingDisabledReason: "public_booking_off" })).toEqual({
      kind: "public_booking_off",
    })
  })
})
