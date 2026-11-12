import { render, screen } from "@testing-library/react"
import type { User } from "firebase/auth"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiSession, RestaurantContext } from "@/lib/api/session"
import type { Live } from "@/lib/firebase/live"

const mocks = vi.hoisted(() => ({ session: { status: "loading" } as Live<ApiSession>, context: { status: "loading" } as Live<RestaurantContext>, legacy: vi.fn(), readContext: vi.fn() }))
vi.mock("@/lib/api/session", () => ({ useApiSession: () => mocks.session, useApiRestaurantContext: (_user: User, rid: string | null) => { mocks.readContext(rid); return mocks.context } }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "llenamos-real" } } } }))
vi.mock("@/lib/firebase/live", () => ({ useLiveDoc: mocks.legacy, useLiveDocs: mocks.legacy, useLiveQuery: mocks.legacy }))
vi.mock("@/lib/auth/AuthProvider", () => ({ signOut: vi.fn() }))
vi.mock("./CrearRestaurante", () => ({ CrearRestaurante: () => <div>Alta legacy</div> }))
const { PanelData } = await import("./PanelData")
const { usePanel } = await import("./PanelContext")
const current = { uid: "u1" } as User
const context: RestaurantContext = {
  restaurant: { id: "r1", name: "Taberna", slug: "taberna", brandColor: "#123456", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: false },
  member: { uid: "u1", displayName: "Persona", email: "persona@example.test", role: "owner", active: true, locationIds: [] },
  locations: [{ id: "local", name: "Centro", slug: "centro", address: "", city: "", phone: "" }],
}
function Probe() { const panel = usePanel(); return <p>{panel.user.uid}:{panel.role}:{panel.restaurant.id}:{panel.location?.id}</p> }
beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
  vi.clearAllMocks()
  mocks.session = { status: "ready", data: { uid: "u1", access: "restaurant", memberships: [{ restaurantId: "r1", name: "Taberna", slug: "taberna", role: "owner", locationIds: [] }] } }
  mocks.context = { status: "ready", data: context }
})
describe("PanelData VPS", () => {
  it.each(["owner", "waiter"] as const)("ofrece contexto SQL para %s sin iniciar listeners Firestore", role => {
    mocks.context = { status: "ready", data: { ...context, member: { ...context.member, role } } }
    render(<PanelData user={current}><Probe /></PanelData>)
    expect(screen.getByText(`u1:${role}:r1:local`)).toBeTruthy()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("platform no puede montar contenido privado ni solicitar contexto restaurante", () => {
    mocks.session = { status: "ready", data: { uid: "u1", access: "platform", memberships: [] } }
    render(<PanelData user={current}><Probe /></PanelData>)
    expect(screen.getByRole("link", { name: "Ir a administración" }).getAttribute("href")).toBe("/logiqd")
    expect(mocks.readContext).toHaveBeenCalledWith(null)
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("cuenta sin membresías muestra falta de asignación, sin crear restaurantes", () => {
    mocks.session = { status: "ready", data: { uid: "u1", access: "restaurant", memberships: [] } }
    render(<PanelData user={current}><Probe /></PanelData>)
    expect(screen.getByText("No tienes restaurantes asignados")).toBeTruthy()
    expect(screen.queryByText("Alta legacy")).toBeNull()
  })
  it("error API no monta hijos ni activa fallback", () => {
    mocks.session = { status: "error", error: new Error("Sin acceso") }
    render(<PanelData user={current}><Probe /></PanelData>)
    expect(screen.getByText("No se ha podido cargar tu acceso")).toBeTruthy()
    expect(mocks.legacy).not.toHaveBeenCalled()
  })
  it("si el flujo en vivo termina con «sin permiso» se explica que ya no hay acceso, sin montar hijos", () => {
    mocks.context = { status: "error", error: Object.assign(new Error("denegado"), { code: "permission-denied" }) }
    render(<PanelData user={current}><Probe /></PanelData>)
    expect(screen.getByText("Ya no tienes acceso a Taberna")).toBeTruthy()
    expect(screen.queryByText(/u1:/)).toBeNull()
  })
})
