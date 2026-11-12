import { describe, expect, it, vi } from "vitest"
import { ApiCallError } from "./transport"
import { deleteFile, downloadFile, publicFilePath, uploadFile, validateFile } from "./files"

const id = "0a0b0c0d-1111-2222-3333-444455556666"
const jpeg = (size = 10) => new File([new Uint8Array(size)], "plato.jpg", { type: "image/jpeg" })
const getToken = async () => "token-privado"

describe("archivos privados del VPS", () => {
  it("sube con el token en la cabecera y nunca en la URL, sin cookies", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ result: { id, contentType: "image/jpeg", sizeBytes: 10, sha256: "a".repeat(64) } }), { status: 201 }))
    const stored = await uploadFile("rest1", "carta_foto", jpeg(), { fetcher, getToken })
    expect(stored.id).toBe(id)
    const [path, init] = fetcher.mock.calls[0]!
    expect(String(path)).toBe("/api/v1/restaurants/rest1/files?purpose=carta_foto&name=plato.jpg")
    expect(String(path)).not.toContain("token-privado")
    expect(init).toMatchObject({ method: "PUT", headers: { "Content-Type": "image/jpeg", Authorization: "Bearer token-privado" }, credentials: "omit", cache: "no-store", redirect: "error" })
  })
  it("valida tipo y tamaño antes de hacer ninguna petición", async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(uploadFile("rest1", "carta_foto", new File(["x"], "a.html", { type: "text/html" }), { fetcher, getToken })).rejects.toMatchObject({ code: "invalid-argument" })
    expect(() => validateFile("carta_foto", { type: "image/jpeg", size: 6 * 1024 * 1024 })).toThrow(ApiCallError)
    expect(() => validateFile("carta_foto", { type: "image/jpeg", size: 0 })).toThrow(ApiCallError)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("traduce los errores del servidor a códigos y no filtra rutas inyectadas", async () => {
    const denied = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ error: { code: "permission-denied", message: "Permisos insuficientes.", requestId: "req_1" } }), { status: 403 }))
    await expect(uploadFile("rest1", "carta_foto", jpeg(), { fetcher: denied, getToken })).rejects.toMatchObject({ code: "permission-denied", message: "Permisos insuficientes.", requestId: "req_1" })
    await expect(downloadFile("../x", id, { fetcher: denied, getToken })).rejects.toMatchObject({ code: "invalid-argument" })
    await expect(downloadFile("rest1", "../../etc/passwd", { fetcher: denied, getToken })).rejects.toMatchObject({ code: "invalid-argument" })
    expect(denied).toHaveBeenCalledTimes(1)
  })
  it("sin sesión no hay petición", async () => {
    const fetcher = vi.fn<typeof fetch>()
    await expect(deleteFile("rest1", id, { fetcher, getToken: async () => { throw new Error("sin cuenta") } })).rejects.toMatchObject({ code: "unauthenticated" })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("descarga y borra con sesión y construye el enlace público estable", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("bytes", { status: 200 }))
    expect(await (await downloadFile("rest1", id, { fetcher, getToken })).text()).toBe("bytes")
    await deleteFile("rest1", id, { fetcher, getToken })
    expect(fetcher.mock.calls.map(call => [String(call[0]), call[1]?.method])).toEqual([[`/api/v1/restaurants/rest1/files/${id}`, "GET"], [`/api/v1/restaurants/rest1/files/${id}`, "DELETE"]])
    expect(publicFilePath("rest1", id)).toBe(`/api/v1/public/files/rest1/${id}`)
  })
})
