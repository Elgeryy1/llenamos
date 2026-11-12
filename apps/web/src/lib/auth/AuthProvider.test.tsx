import { act, render, screen } from "@testing-library/react"
import type { User } from "firebase/auth"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ changed: null as null | ((user: User | null) => void), unsubscribe: vi.fn(), cancel: vi.fn(), signOut: vi.fn(), auth: {} }))
vi.mock("firebase/auth", () => ({
  onAuthStateChanged: (_auth: unknown, callback: (user: User | null) => void) => { mocks.changed = callback; return mocks.unsubscribe },
  signOut: mocks.signOut,
}))
vi.mock("@/lib/firebase/auth-client", () => ({ getFirebaseIdentity: () => ({ auth: mocks.auth }) }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => { throw Error("No debe cargar datos Firebase") } }))
vi.mock("@/lib/api/transport", () => ({ cancelIdentityRequests: mocks.cancel }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: {} } }))
const { AuthProvider, useAuth, signOut } = await import("./AuthProvider")
function Probe() { const auth = useAuth(); return <p>{auth.status === "signedIn" ? auth.user.uid : auth.status}</p> }
beforeEach(() => { vi.clearAllMocks(); mocks.signOut.mockResolvedValue(undefined) })

describe("AuthProvider solo identidad", () => {
  it("observa entrada/salida sin inicializar datos y cancela peticiones al cambiar uid", () => {
    const view = render(<AuthProvider><Probe /></AuthProvider>)
    expect(screen.getByText("loading")).toBeTruthy()
    act(() => mocks.changed?.(null))
    expect(screen.getByText("signedOut")).toBeTruthy()
    act(() => mocks.changed?.({ uid: "u1" } as User))
    expect(screen.getByText("u1")).toBeTruthy()
    act(() => mocks.changed?.({ uid: "u2" } as User))
    expect(screen.getByText("u2")).toBeTruthy()
    expect(mocks.cancel).toHaveBeenCalledTimes(2)
    act(() => mocks.changed?.(null))
    expect(screen.getByText("signedOut")).toBeTruthy()
    view.unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledOnce()
  })
  it("cancela solicitudes antes de llamar al logout", async () => {
    await signOut()
    expect(mocks.cancel.mock.invocationCallOrder[0]).toBeLessThan(mocks.signOut.mock.invocationCallOrder[0]!)
    expect(mocks.signOut).toHaveBeenCalledWith(mocks.auth)
  })
})
