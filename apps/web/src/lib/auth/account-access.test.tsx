import { act, renderHook, waitFor } from "@testing-library/react"
import type { User } from "firebase/auth"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiCallError } from "@/lib/api/transport"

vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, emulators: { host: "127.0.0.1", ports: { auth: 9099 } } } } }))
import { accountDestination, hasRestaurantAccess, readAccountAccess, useAccountAccess, type AccountAccess } from "./account-access"
const user = (uid: string, platformClaim = false) => ({ uid, getIdToken: vi.fn(async () => `jwt-${uid}`), getIdTokenResult: vi.fn(async () => ({ claims: { logiqd: platformClaim } })) }) as unknown as User
const session = (uid: string, access: "platform" | "restaurant", role = "owner") => ({ uid, access, memberships: access === "platform" ? [] : [{ restaurantId: "r1", name: "Taberna", slug: "taberna", role, locationIds: [] }] })
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200 })
beforeEach(() => vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"))
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe("autoridad de acceso según backend", () => {
  it.each(["owner", "waiter"])("el rol %s procede de SQL aunque Auth afirme LogiQD", async role => {
    const current = user("u1", true)
    const access = await readAccountAccess(current, { fetcher: vi.fn(async () => response(session("u1", "restaurant", role))) })
    expect(access).toMatchObject({ source: "postgres", access: "restaurant", session: { memberships: [{ role }] } })
    expect(accountDestination(access, "/logiqd")).toBe("/panel")
    expect(accountDestination(access, "/panel/cocina")).toBe("/panel/cocina")
    expect(accountDestination(access, "https://otro.test")).toBe("/panel")
    expect(current.getIdTokenResult).not.toHaveBeenCalled()
  })
  it("una cuenta SQL plataforma entra aunque el token carezca del claim antiguo", async () => {
    const current = user("admin")
    const access = await readAccountAccess(current, { fetcher: vi.fn(async () => response(session("admin", "platform"))) })
    expect(accountDestination(access, "/panel")).toBe("/logiqd")
    expect(hasRestaurantAccess(access)).toBe(false)
    expect(current.getIdTokenResult).not.toHaveBeenCalled()
  })
  it("sin membresías SQL no concede destino ni rol desde un claim", () => {
    const access: AccountAccess = { source: "postgres", uid: "u1", access: "restaurant", session: { uid: "u1", access: "restaurant", memberships: [] } }
    expect(hasRestaurantAccess(access)).toBe(false)
    expect(() => accountDestination(access, "/panel")).toThrow(ApiCallError)
  })
  it("solo demo con emuladores conserva el selector por claim", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    const current = user("demo", true), fetcher = vi.fn<typeof fetch>()
    const access = await readAccountAccess(current, { fetcher })
    expect(access).toEqual({ source: "firebase-demo", uid: "demo", access: "platform" })
    expect(accountDestination(access, "/panel")).toBe("/logiqd")
    expect(fetcher).not.toHaveBeenCalled()
    expect(current.getIdTokenResult).toHaveBeenCalledWith(true)
  })
  it("cambia de usuario sin exponer el acceso anterior y descarta respuesta tardía", async () => {
    let finishOld: (value: Response) => void = () => undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve })).mockImplementationOnce(async () => response(session("new", "restaurant")))
    vi.stubGlobal("fetch", fetcher)
    const oldUser = user("old"), newUser = user("new")
    const hook = renderHook(({ current }) => useAccountAccess(current), { initialProps: { current: oldUser } })
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    hook.rerender({ current: newUser })
    expect(hook.result.current.status).toBe("loading")
    await waitFor(() => expect(hook.result.current).toMatchObject({ status: "ready", data: { uid: "new", access: "restaurant" } }))
    await act(async () => finishOld(response(session("old", "platform"))))
    expect(hook.result.current).toMatchObject({ status: "ready", data: { uid: "new", access: "restaurant" } })
  })
  it("al renovar la identidad con el mismo UID espera una verificación SQL nueva", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(async () => response(session("u1", "platform"))).mockImplementationOnce(async () => new Response(JSON.stringify({ error: { code: "unauthenticated", message: "Sesión revocada." } }), { status: 401 }))
    vi.stubGlobal("fetch", fetcher)
    const hook = renderHook(({ current }) => useAccountAccess(current), { initialProps: { current: user("u1") } })
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))
    hook.rerender({ current: user("u1") })
    expect(hook.result.current.status).toBe("loading")
    await waitFor(() => expect(hook.result.current).toMatchObject({ status: "error", error: { code: "unauthenticated" } }))
  })
})
