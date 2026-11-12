import { describe, expect, it, vi } from "vitest"
import { ApiCallError, operationPath, postOperation } from "./transport"

const ok = (result: unknown) => vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result }), { status: 200 }))
describe("transporte VPS", () => {
  it("envía token solo en la cabecera, a ruta local fija, sin cookies ni redirecciones", async () => {
    const fetcher = ok({ plans: [] })
    expect(await postOperation("listarPlanesDisponibles", {}, { authentication: "required", getToken: async () => "token-privado", fetcher })).toEqual({ plans: [] })
    const [path, init] = fetcher.mock.calls[0]!
    expect(path).toBe("/api/v1/operations/listarPlanesDisponibles")
    expect(init).toMatchObject({ method: "POST", headers: { Authorization: "Bearer token-privado", "Content-Type": "application/json" }, credentials: "omit", cache: "no-store", redirect: "error" })
    expect(init?.body).toBe('{"data":{}}')
    expect(path).not.toContain("token-privado")
  })
  it("una operación pública no consulta ni envía identidad", async () => {
    const fetcher = ok(null), getToken = vi.fn(async () => "token")
    await postOperation("consultarDisponibilidad", { date: "2026-11-10" }, { authentication: "none", getToken, fetcher })
    expect(getToken).not.toHaveBeenCalled()
    expect(fetcher.mock.calls[0]?.[1]?.headers).toEqual({ "Content-Type": "application/json" })
  })
  it("rechaza rutas o cabeceras inyectadas antes de hacer una petición", async () => {
    for (const name of ["../datos", "https://mal.example", "x?token=privado", "x/y", "x#fragment"]) expect(() => operationPath(name)).toThrow(ApiCallError)
    const fetcher = ok({})
    await expect(postOperation("listarPlanesDisponibles", {}, { authentication: "required", getToken: async () => "x\r\nCookie: x", fetcher })).rejects.toMatchObject({ code: "unauthenticated" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("si no hay sesión no hace petición ni cambia de backend", async () => {
    const fetcher = ok({})
    await expect(postOperation("listarPlanesDisponibles", {}, { authentication: "required", getToken: async () => { throw new Error("sin cuenta") }, fetcher })).rejects.toMatchObject({ code: "unauthenticated" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("mantiene códigos y correlación sin enseñar errores internos", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: "permission-denied", message: "No tienes acceso.", requestId: "request_123" } }), { status: 403 }))
    await expect(postOperation("listarPlanesDisponibles", {}, { authentication: "none", fetcher })).rejects.toMatchObject({ code: "permission-denied", message: "No tienes acceso.", requestId: "request_123" })
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ error: { code: "internal", message: "password=secreto" } }), { status: 500 }))
    await expect(postOperation("listarPlanesDisponibles", {}, { authentication: "none", fetcher })).rejects.toMatchObject({ code: "internal", message: "No se ha podido completar la operación." })
  })
  it("una operación no migrada devuelve 404 honesto, sin fallback", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("Not found", { status: 404 }))
    await expect(postOperation("crearReservaPublica", {}, { authentication: "none", fetcher })).rejects.toMatchObject({ code: "not-deployed" })
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("no acepta una respuesta ajena al protocolo ni una red caída", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }))
    await expect(postOperation("crearReservaPublica", {}, { authentication: "none", fetcher })).rejects.toMatchObject({ code: "internal" })
    fetcher.mockRejectedValue(new Error("network secret"))
    await expect(postOperation("crearReservaPublica", {}, { authentication: "none", fetcher })).rejects.toMatchObject({ code: "network", message: "No hay conexión con el servidor." })
  })
  it("cancela también la espera del token y nunca envía después del timeout", async () => {
    let resolveToken: (value: string) => void = () => undefined
    const getToken = () => new Promise<string>(resolve => { resolveToken = resolve })
    const fetcher = ok({})
    await expect(postOperation("listarPlanesDisponibles", {}, { authentication: "required", getToken, timeoutMs: 10, fetcher })).rejects.toMatchObject({ code: "deadline-exceeded" })
    resolveToken("token-tardio")
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("corta la petición por timeout y respeta una cancelación previa", async () => {
    const fetcher = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("abort", "AbortError")))))
    await expect(postOperation("crearReservaPublica", {}, { authentication: "none", timeoutMs: 10, fetcher })).rejects.toMatchObject({ code: "deadline-exceeded" })
    fetcher.mockClear()
    const controller = new AbortController(); controller.abort()
    await expect(postOperation("crearReservaPublica", {}, { authentication: "none", signal: controller.signal, fetcher })).rejects.toMatchObject({ name: "AbortError" })
    expect(fetcher).not.toHaveBeenCalled()
  })
})
