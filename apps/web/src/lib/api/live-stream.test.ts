import { describe, expect, it, vi } from "vitest"
import { ApiCallError } from "./transport"
import { backoffDelay, createFrameParser, livePath, runLiveStream } from "./live-stream"

const encoder = new TextEncoder()
function stream(chunks: string[], end = true): Response {
  return new Response(new ReadableStream({
    start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); if (end) controller.close() },
  }), { status: 200, headers: { "Content-Type": "text/event-stream" } })
}
const snapshot = (id: number, value: unknown) => `id: ${id}\nevent: snapshot\ndata: ${JSON.stringify(value)}\n\n`
const noSleep = vi.fn(async () => undefined)

describe("cliente SSE de lecturas en vivo", () => {
  it("trocea tramas partidas por cualquier byte e ignora comentarios", () => {
    const frames: unknown[] = []
    const feed = createFrameParser(frame => frames.push(frame))
    for (const char of `: ping\n\nid: 7\nevent: snapshot\ndata: {"a":\ndata: 1}\n\nretry: 3000\n\n`) feed(char)
    expect(frames).toEqual([{ id: "7", event: "snapshot", data: '{"a":\n1}' }])
  })
  it("envía el token solo en la cabecera, a una ruta fija, sin cookies ni redirecciones", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>(async () => stream([snapshot(5, { n: 1 })]))
    const got: unknown[] = []
    await runLiveStream({ name: "reservasDia", input: { restaurantId: "r1" }, signal: controller.signal, fetcher, getToken: async () => "token-privado",
      sleep: async () => { controller.abort() }, onSnapshot: data => got.push(data), onFatal: () => undefined })
    const [path, init] = fetcher.mock.calls[0]!
    expect(path).toBe("/api/v1/live/reservasDia")
    expect(String(path)).not.toContain("token-privado")
    expect(init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store", redirect: "error" })
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer token-privado")
    expect(init?.body).toBe('{"data":{"restaurantId":"r1"}}')
    expect(got).toEqual([{ n: 1 }])
  })
  it("reconecta con Last-Event-ID y espera creciente tras cortes, sin avisar de errores pasajeros", async () => {
    const controller = new AbortController()
    let call = 0
    const fetcher = vi.fn<typeof fetch>(async () => {
      call += 1
      if (call === 1) return stream([snapshot(9, 1)])
      if (call === 2 || call === 3) throw new Error("red caída")
      controller.abort()
      return stream([snapshot(12, 2)])
    })
    const waits: number[] = []
    const fatal = vi.fn(), got: unknown[] = []
    await runLiveStream({ name: "q", input: {}, signal: controller.signal, fetcher, getToken: async () => "t", random: () => 0.5,
      sleep: async ms => { waits.push(ms) }, onSnapshot: d => got.push(d), onFatal: fatal })
    expect(fatal).not.toHaveBeenCalled()
    expect(waits.slice(0, 3)).toEqual([1000, 2000, 4000])
    expect((fetcher.mock.calls[1]![1]!.headers as Record<string, string>)["Last-Event-ID"]).toBe("9")
    expect(got).toEqual([1, 2])
  })
  it("el backoff crece, se acota y lleva variación", () => {
    expect([1, 2, 3, 4, 5, 6, 7].map(n => backoffDelay(n, () => 0.5))).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000])
    expect(backoffDelay(1, () => 0)).toBe(750)
    expect(backoffDelay(1, () => 1)).toBe(1250)
  })
  it("un 403 es definitivo y no se reintenta; 401 también", async () => {
    for (const [status, code] of [[403, "permission-denied"], [401, "unauthenticated"], [404, "not-deployed"]] as const) {
      const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code, message: "secreto interno" } }), { status }))
      const fatal = vi.fn()
      await runLiveStream({ name: "q", input: {}, signal: new AbortController().signal, fetcher, getToken: async () => "t", sleep: noSleep, onSnapshot: () => undefined, onFatal: fatal })
      expect(fetcher).toHaveBeenCalledOnce()
      expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code }))
      expect(fatal.mock.calls[0]![0].message).not.toContain("secreto")
    }
  })
  it("un evento error del servidor por sesión revocada detiene el flujo; uno pasajero reconecta", async () => {
    const fatal = vi.fn()
    const revoked = vi.fn<typeof fetch>(async () => stream([snapshot(1, 1), 'event: error\ndata: {"code":"unauthenticated"}\n\n']))
    await runLiveStream({ name: "q", input: {}, signal: new AbortController().signal, fetcher: revoked, getToken: async () => "t", sleep: noSleep, onSnapshot: () => undefined, onFatal: fatal })
    expect(revoked).toHaveBeenCalledOnce()
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthenticated" }))
    const controller = new AbortController()
    let calls = 0
    const transient = vi.fn<typeof fetch>(async () => { calls += 1; if (calls === 2) controller.abort(); return stream(['event: error\ndata: {"code":"unavailable"}\n\n']) })
    const again = vi.fn()
    await runLiveStream({ name: "q", input: {}, signal: controller.signal, fetcher: transient, getToken: async () => "t", sleep: noSleep, onSnapshot: () => undefined, onFatal: again })
    expect(transient).toHaveBeenCalledTimes(2)
    expect(again).not.toHaveBeenCalled()
  })
  it("si falla el token no hace ninguna petición y avisa de sesión caducada", async () => {
    const fetcher = vi.fn<typeof fetch>()
    const fatal = vi.fn()
    await runLiveStream({ name: "q", input: {}, signal: new AbortController().signal, fetcher, getToken: async () => { throw new Error("x") }, sleep: noSleep, onSnapshot: () => undefined, onFatal: fatal })
    expect(fetcher).not.toHaveBeenCalled()
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "unauthenticated" }))
  })
  it("cancelar corta la lectura en curso y no entrega nada después", async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const body = new ReadableStream({ start(c) { c.enqueue(encoder.encode(snapshot(1, "uno"))); init?.signal?.addEventListener("abort", () => c.error(new DOMException("abort", "AbortError"))) } })
      return new Response(body, { status: 200 })
    })
    const got: unknown[] = []
    const running = runLiveStream({ name: "q", input: {}, signal: controller.signal, fetcher, getToken: async () => "t", onSnapshot: d => { got.push(d); controller.abort() }, onFatal: () => undefined })
    await running
    expect(got).toEqual(["uno"])
    expect(fetcher).toHaveBeenCalledOnce()
  })
  it("rechaza nombres que pudieran alterar la ruta", () => {
    for (const name of ["../x", "a/b", "a?token=1", "1a", ""]) expect(() => livePath(name)).toThrow(ApiCallError)
  })
  it("un error fatal del servidor (foto demasiado grande) no se reintenta aunque su código sea transitorio", async () => {
    const fatal = vi.fn()
    const fetcher = vi.fn<typeof fetch>(async () => stream(['event: error\ndata: {"code":"resource-exhausted","fatal":true}\n\n']))
    await runLiveStream({ name: "q", input: {}, signal: new AbortController().signal, fetcher, getToken: async () => "t", sleep: noSleep, onSnapshot: () => undefined, onFatal: fatal })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(fatal).toHaveBeenCalledWith(expect.objectContaining({ code: "resource-exhausted", fatal: true }))
  })
})
