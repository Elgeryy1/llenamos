import { describe, expect, it } from "vitest"
import { bookingHref, calendarFile, manageHref, mapsHref, widgetHref } from "./enlaces"
import { dayOptions, formatLongDate, todayIn, wallOf } from "./fechas"
import { translator } from "./i18n"

describe("enlaces", () => {
  it("sigue las rutas del contrato", () => {
    expect(bookingHref("taberna-lumbre")).toBe("/r/taberna-lumbre")
    expect(bookingHref("taberna-lumbre", "ca")).toBe("/r/taberna-lumbre?lang=ca")
    expect(widgetHref("taberna-lumbre", "en")).toBe("/widget/taberna-lumbre?lang=en")
    expect(manageHref("taberna-lumbre", "K7Q2MD", "tok_en-1")).toBe("/r/taberna-lumbre/reserva/K7Q2MD?t=tok_en-1")
    expect(manageHref("taberna-lumbre", "K7Q2MD", "tok", "ca", true)).toBe("/r/taberna-lumbre/reserva/K7Q2MD?t=tok&nueva=1&lang=ca")
  })

  it("abre el local en el mapa si tiene dirección", () => {
    expect(mapsHref({ name: "Centro", address: "Carrer de la Lumbre 12", city: "Barcelona" }, "Taberna Lumbre")).toBe(
      "https://www.google.com/maps/search/?api=1&query=Taberna%20Lumbre%2C%20Carrer%20de%20la%20Lumbre%2012%2C%20Barcelona",
    )
    expect(mapsHref({ name: "Centro", address: " ", city: "" }, "Taberna Lumbre")).toBeNull()
  })

  it("crea un archivo de calendario válido y con los textos escapados", () => {
    const ics = calendarFile({
      uid: "K7Q2MD",
      title: "Reserva en Taberna Lumbre",
      description: "Reserva K7Q2MD para 3 personas, mesa; terraza",
      location: "Carrer de la Lumbre 12, Barcelona",
      startAt: Date.UTC(2026, 10, 12, 20, 0),
      durationMinutes: 90,
      url: "https://llenamos.logiqd.me/r/taberna-lumbre/reserva/K7Q2MD?t=x",
      now: Date.UTC(2026, 10, 9, 10, 0),
    })
    expect(ics).toContain("DTSTART:20261112T200000Z")
    expect(ics).toContain("DTEND:20261112T213000Z")
    expect(ics).toContain("DESCRIPTION:Reserva K7Q2MD para 3 personas\\, mesa\\; terraza\\nhttps://")
    expect(ics).toContain("LOCATION:Carrer de la Lumbre 12\\, Barcelona")
    expect(ics.split("\r\n").at(-2)).toBe("END:VCALENDAR")
  })
})

describe("fechas en la hora del restaurante", () => {
  it("el día de hoy es el del restaurante, no el del navegador", () => {
    // 23:30 UTC del 9 de noviembre ya es día 10 en Madrid.
    expect(todayIn("Europe/Madrid", Date.UTC(2026, 10, 9, 23, 30))).toBe("2026-11-10")
    expect(wallOf(Date.UTC(2026, 10, 12, 20, 0), "Europe/Madrid")).toEqual({ date: "2026-11-12", time: "21:00" })
  })

  it("da los días elegibles con hoy y mañana en cada idioma", () => {
    const days = dayOptions("2026-11-09", 30, "es", translator("es"), 9)
    expect(days).toHaveLength(9)
    expect(days.slice(0, 3).map((d) => d.label)).toEqual(["hoy", "mañana", "mié"])
    expect(days[3]).toMatchObject({ date: "2026-11-12", day: "12" })
    expect(days[3]?.accessible).toBe("jueves, 12 de noviembre")
    expect(dayOptions("2026-11-09", 2, "ca", translator("ca"))).toHaveLength(3)
    expect(dayOptions("2026-11-09", 60, "en", translator("en"))[1]?.label).toBe("tomorrow")
  })

  it("escribe la fecha larga sin puntos ni comas", () => {
    expect(formatLongDate("2026-11-12", "es")).toBe("jueves 12 nov")
    expect(formatLongDate("2026-11-12", "en")).toBe("Thursday 12 Nov")
    expect(formatLongDate("2026-11-12", "ca")).toMatch(/^dijous 12/)
  })
})
