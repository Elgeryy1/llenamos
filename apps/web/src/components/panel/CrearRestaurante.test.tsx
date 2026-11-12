import { render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { User } from "firebase/auth"

const mocks = vi.hoisted(() => ({ llamar: vi.fn(), signOut: vi.fn() }))
vi.mock("@/lib/auth/AuthProvider", () => ({ signOut: mocks.signOut }))
vi.mock("@/lib/data/functions", async importOriginal => ({ ...(await importOriginal<typeof import("@/lib/data/functions")>()), llamarFuncion: mocks.llamar }))

const { CrearRestaurante } = await import("./CrearRestaurante")
const user = { uid: "u1", displayName: "Ana Pérez" } as User

describe("CrearRestaurante", () => {
  afterEach(() => { vi.unstubAllEnvs(); mocks.llamar.mockReset() })

  it("en el VPS no ofrece el alta propia: remite a LogiQD y deja salir", () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    render(<CrearRestaurante user={user} onCreated={vi.fn()} />)
    expect(screen.getByText(/hola@logiqd.me/)).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Crear restaurante" })).toBeNull()
    expect(screen.getByRole("button", { name: "Salir" })).toBeTruthy()
    expect(mocks.llamar).not.toHaveBeenCalled()
  })

  it("en la demo conserva el formulario de alta", () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    render(<CrearRestaurante user={user} onCreated={vi.fn()} />)
    expect(screen.getByRole("button", { name: "Crear restaurante" })).toBeTruthy()
  })
})
