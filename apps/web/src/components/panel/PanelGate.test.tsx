import { act, fireEvent, render, screen } from "@testing-library/react"
import type { User } from "firebase/auth"
import { useState, type ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthState } from "@/lib/auth/AuthProvider"
import type { AccountAccess } from "@/lib/auth/account-access"
import type { Live } from "@/lib/firebase/live"

const mocks = vi.hoisted(() => ({
  auth: { status: "loading" } as AuthState,
  replace: vi.fn(),
  access: { status: "ready", data: { source: "firebase-demo", uid: "u1", access: "restaurant" } } as Live<AccountAccess>,
}))

vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: () => mocks.auth }))
vi.mock("@/lib/auth/account-access", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/auth/account-access")>(), useAccountAccess: () => mocks.access }))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
  usePathname: () => "/panel/equipo",
}))
vi.mock("./PanelShell", () => ({ PanelShell: ({ children }: { children: ReactNode }) => <>{children}</> }))
// En lugar de leer Firestore, el sustituto guarda un estado propio (como el
// restaurante o el local elegidos) para ver si pasa de una cuenta a otra.
vi.mock("./PanelData", () => ({
  PanelData: function PanelData({ user, children }: { user: User; children: ReactNode }) {
    const [firstUid] = useState(user.uid)
    const [touched, setTouched] = useState(false)
    return (
      <div>
        <p>
          datos de {firstUid} para {user.uid}
          {touched ? " (tocado)" : ""}
        </p>
        <button onClick={() => setTouched(true)}>tocar</button>
        {children}
      </div>
    )
  },
}))

const { PanelGate } = await import("./PanelGate")

const as = (uid: string) => ({ status: "signedIn", user: { uid } as User }) as AuthState

describe("PanelGate", () => {
  beforeEach(() => {
    mocks.replace.mockReset()
    mocks.access = { status: "ready", data: { source: "firebase-demo", uid: "u1", access: "restaurant" } }
  })

  it("al cambiar de cuenta empieza de cero", () => {
    mocks.auth = as("ana")
    const view = render(<PanelGate>página</PanelGate>)
    fireEvent.click(screen.getByRole("button", { name: "tocar" }))
    expect(screen.getByText("datos de ana para ana (tocado)")).toBeTruthy()

    mocks.auth = as("bea")
    view.rerender(<PanelGate>página</PanelGate>)
    expect(screen.getByText("datos de bea para bea")).toBeTruthy()
  })

  it("tras «Salir» va a /entrar sin recordar la página", () => {
    mocks.auth = as("ana")
    const view = render(<PanelGate>página</PanelGate>)
    act(() => {
      mocks.auth = { status: "signedOut", byUser: true }
      view.rerender(<PanelGate>página</PanelGate>)
    })
    expect(mocks.replace).toHaveBeenCalledWith("/entrar")
    expect(screen.queryByText("página")).toBeNull()
    expect(screen.getByRole("status").textContent).toContain("Cargando el panel…")
  })

  it("si la sesión caduca, vuelve después a la misma página", () => {
    mocks.auth = { status: "signedOut", byUser: false }
    render(<PanelGate>página</PanelGate>)
    expect(mocks.replace).toHaveBeenCalledWith("/entrar?siguiente=%2Fpanel%2Fequipo")
  })
  it("LogiQD nunca monta datos del restaurante aunque solicite su panel", () => {
    mocks.auth = as("logiqd")
    mocks.access = { status: "ready", data: { source: "postgres", uid: "logiqd", access: "platform", session: { uid: "logiqd", access: "platform", memberships: [] } } }
    render(<PanelGate>contenido privado</PanelGate>)
    expect(mocks.replace).toHaveBeenCalledWith("/logiqd")
    expect(screen.queryByText("contenido privado")).toBeNull()
    expect(screen.queryByText(/datos de logiqd/)).toBeNull()
  })
  it("SQL sin membresías no monta datos ni permite el panel", () => {
    mocks.auth = as("sin-acceso")
    mocks.access = { status: "ready", data: { source: "postgres", uid: "sin-acceso", access: "restaurant", session: { uid: "sin-acceso", access: "restaurant", memberships: [] } } }
    render(<PanelGate>contenido privado</PanelGate>)
    expect(screen.getByText("No tienes restaurantes asignados")).toBeTruthy()
    expect(screen.queryByText(/datos de/)).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
  it("error de acceso SQL no monta el panel ni redirige con datos viejos", () => {
    mocks.auth = as("revocado")
    mocks.access = { status: "error", error: new Error("token revocado") }
    render(<PanelGate>contenido privado</PanelGate>)
    expect(screen.getByText("No se ha podido comprobar tu acceso")).toBeTruthy()
    expect(screen.queryByText(/datos de/)).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
