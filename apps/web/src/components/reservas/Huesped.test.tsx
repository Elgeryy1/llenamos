import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { CustomerDoc } from "@/lib/data/reservas"
import { reservation } from "@/lib/reservas/fixtures"
import { GuestBadges, guestBadges, SourceLabel } from "./Huesped"

const customer = (changes: Partial<CustomerDoc> = {}): CustomerDoc =>
  ({ id: "c1", name: "Laia", phone: "+34600000000", email: null, language: "es", visits: 4, noShows: 0, cancellations: 0, lastVisitAt: null, notes: "", allergies: "", tags: [], ...changes }) as CustomerDoc

describe("etiquetas del cliente en las filas del servicio", () => {
  it("alergia primero, luego habitual, cumpleaños e idioma", () => {
    const r = reservation({ language: "en", guestNotes: "Cumpleaños, traen tarta" })
    const keys = guestBadges(r, customer({ allergies: "Frutos secos", tags: ["habitual"] })).map((b) => b.key)
    expect(keys).toEqual(["alergia", "habitual", "fiesta", "idioma"])
  })

  it("una nota de alergia sin ficha también avisa", () => {
    const r = reservation({ guestNotes: "Celíaca" })
    expect(guestBadges(r, null)[0]).toMatchObject({ key: "alergia", label: "Celíaca" })
  })

  it("se leen con palabra y no solo con color", () => {
    render(<GuestBadges reservation={reservation({ guestNotes: "Necesitan trona" })} customer={customer({ allergies: "Gluten" })} />)
    expect(screen.getByText("Gluten")).toBeTruthy()
    expect(screen.getByText("Necesitan trona")).toBeTruthy()
  })

  it("de dónde viene la reserva", () => {
    render(<SourceLabel source="walk_in" />)
    expect(screen.getByText("sin reserva")).toBeTruthy()
  })
})
