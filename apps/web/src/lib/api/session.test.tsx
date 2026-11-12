import { act, renderHook, waitFor } from "@testing-library/react"
import type { User } from "firebase/auth"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/firebase/auth-client", () => ({ identityToken: async () => "token-de-prueba" }))
import { readRestaurantContext, readSession, useApiRestaurantContext, useApiSession } from "./session"
import { cancelIdentityRequests, getIdentityResource } from "./transport"

const user = (uid: string) => ({ uid, getIdToken: vi.fn(async () => `token-${uid}`) }) as unknown as User
const membership = { restaurantId: "r1", name: "Taberna", slug: "taberna", role: "owner", locationIds: [] }
const session = (uid = "u1", access = "restaurant", role = "owner") => ({ uid, access, memberships: access === "platform" ? [] : [{ ...membership, role }] })
const context = (uid = "u1", role = "owner", locationIds: string[] = []) => ({
  restaurant: { id: "r1", name: "Taberna", slug: "taberna", brandColor: "#123456", currency: "EUR", timezone: "Europe/Madrid", locale: "es", isDemo: false },
  member: { uid, displayName: "Persona", email: "persona@example.test", role, active: true, locationIds },
  locations: [{ id: "centro", name: "Centro", slug: "centro", address: "Calle Mayor", city: "Madrid", phone: "" }],
})
const fetchReply = (value: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify(value), { status: 200 }))
afterEach(() => { cancelIdentityRequests(); vi.unstubAllGlobals() })

describe("sesión y contexto SQL", () => {
  it("lee una sesión platform sin convertirla en miembro ni mandar cookies", async () => {
    const fetcher = fetchReply(session("admin", "platform"))
    expect(await readSession("admin", { fetcher, getToken: async () => "token-admin" })).toMatchObject({ access: "platform", memberships: [] })
    expect(fetcher).toHaveBeenCalledWith("/api/v1/session", expect.objectContaining({ method: "GET", credentials: "omit", redirect: "error", cache: "no-store", headers: expect.objectContaining({ Authorization: "Bearer token-admin" }) }))
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined()
  })
  it.each(["owner", "waiter"])("obtiene rol %s desde SQL", async role => {
    expect(await readSession("u1", { fetcher: fetchReply(session("u1", "restaurant", role)), getToken: async () => "t" })).toMatchObject({ memberships: [{ role }] })
    expect(await readRestaurantContext("u1", "r1", { fetcher: fetchReply(context("u1", role)), getToken: async () => "t" })).toMatchObject({ member: { role } })
  })
  it("rechaza sesiones cruzadas, membresías duplicadas y platform con membresías", async () => {
    const duplicate = session(); duplicate.memberships.push(duplicate.memberships[0]!)
    for (const value of [session("otro"), duplicate, { ...session(), access: "platform" }]) {
      await expect(readSession("u1", { fetcher: fetchReply(value), getToken: async () => "t" })).rejects.toMatchObject({ code: "internal" })
    }
  })
  it("rechaza contexto de otro usuario/restaurante, inactivo o fuera de locales asignados", async () => {
    for (const value of [context("otro"), { ...context(), restaurant: { ...context().restaurant, id: "r2" } }, { ...context(), member: { ...context().member, active: false } }, context("u1", "waiter", ["otro-local"])]) {
      await expect(readRestaurantContext("u1", "r1", { fetcher: fetchReply(value), getToken: async () => "t" })).rejects.toMatchObject({ code: "internal" })
    }
  })
  it("sin identidad o con ruta ajena al contrato no llama al servidor", async () => {
    const fetcher = fetchReply(session())
    await expect(readSession("u1", { fetcher, getToken: async () => { throw Error("signed out") } })).rejects.toMatchObject({ code: "unauthenticated" })
    await expect(getIdentityResource("https://example.test", { fetcher })).rejects.toMatchObject({ code: "invalid-argument" })
    await expect(readRestaurantContext("u1", "../r2", { fetcher })).rejects.toMatchObject({ code: "invalid-argument" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("no mantiene datos de una cuenta anterior mientras llega la nueva", async () => {
    let completeOld: (r: Response) => void = () => undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve })).mockImplementationOnce(async () => new Response(JSON.stringify(session("u2"))))
    vi.stubGlobal("fetch", fetcher)
    const oldUser = user("u1"), newUser = user("u2")
    const hook = renderHook(({ current }) => useApiSession(current), { initialProps: { current: oldUser } })
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    hook.rerender({ current: newUser })
    expect(hook.result.current.status).toBe("loading")
    await waitFor(() => expect(hook.result.current).toMatchObject({ status: "ready", data: { uid: "u2" } }))
    await act(async () => completeOld(new Response(JSON.stringify(session("u1")))))
    expect(hook.result.current).toMatchObject({ status: "ready", data: { uid: "u2" } })
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
  })
  const sse = (value: unknown, id = 1) => `id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(value)}\n\n`
  const liveFetch = (frames: string[]) => vi.fn<typeof fetch>(async () => new Response(new ReadableStream({ start(controller) { for (const frame of frames) controller.enqueue(new TextEncoder().encode(frame)) } }), { status: 200 }))
  it("el contexto llega en vivo y un cambio de restaurante oculta inmediatamente el previo", async () => {
    const fetcher = liveFetch([sse(context())])
    vi.stubGlobal("fetch", fetcher)
    const current = user("u1")
    const hook = renderHook(({ rid }) => useApiRestaurantContext(current, rid), { initialProps: { rid: "r1" as string | null } })
    await waitFor(() => expect(hook.result.current.status).toBe("ready"))
    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/live/contextoRestaurante")
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ data: { restaurantId: "r1" } })
    hook.rerender({ rid: null })
    expect(hook.result.current.status).toBe("loading")
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("un contexto en vivo de otro usuario o restaurante se descarta como respuesta no válida", async () => {
    for (const value of [context("otro"), { ...context(), member: { ...context().member, active: false } }]) {
      vi.stubGlobal("fetch", liveFetch([sse(value)]))
      const hook = renderHook(() => useApiRestaurantContext(user("u1"), "r1"))
      await waitFor(() => expect(hook.result.current).toMatchObject({ status: "error", error: { code: "internal" } }))
      hook.unmount()
    }
  })
  it("al cerrar sesión cancela incluso un fetch que todavía no ha resuelto", async () => {
    let finish: (r: Response) => void = () => undefined
    const fetcher = vi.fn<typeof fetch>(() => new Promise(resolve => { finish = resolve }))
    const pending = readSession("u1", { fetcher, getToken: async () => "t" })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    cancelIdentityRequests()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
    finish(new Response(JSON.stringify(session())))
  })
  it("expone el error de acceso SQL sin fallback a Firestore", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ error: { code: "permission-denied", message: "No tienes acceso." } }), { status: 403 })))
    const current = user("u1")
    const hook = renderHook(() => useApiSession(current))
    await waitFor(() => expect(hook.result.current).toMatchObject({ status: "error", error: { code: "permission-denied" } }))
  })
})
