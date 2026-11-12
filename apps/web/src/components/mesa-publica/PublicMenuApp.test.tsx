import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PublicProvider } from "@/components/publica/PublicContext"
import { exampleMenu } from "@/lib/carta/fixtures.test-data"
import { PublicMenuApp } from "./PublicMenuApp"

vi.mock("@/lib/config/hooks", () => ({
  usePublicRestaurant: () => ({ status: "ready", data: {
    restaurantId: "demo-lumbre", name: "Taberna Lumbre", brandColor: "#f0a35e",
    timezone: "Europe/Madrid", locations: [{ id: "centro", name: "Centro" }],
  } }),
}))
vi.mock("@/lib/carta/hooks", () => ({
  publicMenuId: () => "menu-publico",
  useMenu: () => ({ status: "ready", data: exampleMenu() }),
}))
vi.mock("@/components/para-llevar-publico/TakeawayApp", () => ({ TakeawayApp: () => <p>Formulario de recogida</p> }))

describe("Título del servicio público", () => {
  it.each([
    [false, "Carta"],
    [true, "Para llevar"],
  ] as const)("identifica el servicio con recogida %s", (takeaway, title) => {
    render(<PublicProvider initialLang="es"><PublicMenuApp slug="taberna-lumbre" takeaway={takeaway} /></PublicProvider>)
    expect(screen.getByRole("heading", { level: 1, name: title })).toBeTruthy()
    expect(screen.queryByRole("heading", { name: /Reservar en/ })).toBeNull()
  })
})
