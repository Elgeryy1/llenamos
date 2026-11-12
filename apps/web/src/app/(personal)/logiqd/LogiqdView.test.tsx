import { render, screen } from "@testing-library/react"
import type { User } from "firebase/auth"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountAccess } from "@/lib/auth/account-access"
import type { AuthState } from "@/lib/auth/AuthProvider"
import type { Live } from "@/lib/firebase/live"

const mocks = vi.hoisted(() => ({ auth: { status: "loading" } as AuthState, access: { status: "loading" } as Live<AccountAccess>, replace: vi.fn() }))
vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: () => mocks.auth, signOut: vi.fn() }))
vi.mock("@/lib/auth/account-access", () => ({ useAccountAccess: () => mocks.access }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }), usePathname: () => "/logiqd" }))
vi.mock("@/components/logiqd/PlatformRestaurants", () => ({ PlatformRestaurants: () => <p>Administración SQL</p> }))
const { LogiqdView } = await import("./LogiqdView")
beforeEach(() => {
  vi.clearAllMocks()
  mocks.auth = { status: "signedIn", user: { uid: "u1", email: "persona@example.test" } as User }
  mocks.access = { status: "loading" }
})
describe("acceso a administración", () => {
  it("solo SQL platform abre administración, sin consultar claims Firebase", () => {
    mocks.access = { status: "ready", data: { source: "postgres", uid: "u1", access: "platform", session: { uid: "u1", access: "platform", memberships: [] } } }
    render(<LogiqdView />)
    expect(screen.getByText("Administración SQL")).toBeTruthy()
  })
  it("una identidad de restaurante no monta administración aunque intente esa URL", () => {
    mocks.access = { status: "ready", data: { source: "postgres", uid: "u1", access: "restaurant", session: { uid: "u1", access: "restaurant", memberships: [] } } }
    render(<LogiqdView />)
    expect(screen.getByText("Esta página es solo para el equipo de LogiQD")).toBeTruthy()
    expect(screen.queryByText("Administración SQL")).toBeNull()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
  it("error SQL no cae a claims ni monta administración", () => {
    mocks.access = { status: "error", error: new Error("Identidad no provisionada") }
    render(<LogiqdView />)
    expect(screen.getByText("No se ha podido comprobar tu acceso")).toBeTruthy()
    expect(screen.queryByText("Administración SQL")).toBeNull()
  })
  it("logout retira inmediatamente administración y vuelve al login", () => {
    mocks.access = { status: "ready", data: { source: "firebase-demo", uid: "u1", access: "platform" } }
    const view = render(<LogiqdView />)
    expect(screen.getByText("Administración SQL")).toBeTruthy()
    mocks.auth = { status: "signedOut", byUser: true }
    view.rerender(<LogiqdView />)
    expect(screen.queryByText("Administración SQL")).toBeNull()
    expect(mocks.replace).toHaveBeenCalledWith("/entrar")
  })
})
