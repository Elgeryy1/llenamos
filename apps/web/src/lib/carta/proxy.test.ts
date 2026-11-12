import { describe, it, expect, vi } from "vitest"
import { proxyCallable } from "./proxy"
vi.mock("@/lib/firebase/config", () => ({
  firebaseConfig: {
    ok: true,
    settings: {
      options: { projectId: "demo-llenamos" },
      region: "europe-west1",
      emulators: { host: "127.0.0.1", ports: { functions: 5016 } },
    },
  },
}))
const request = () =>
  new Request("http://localhost:3015/m/api/verMesaPublica", {
    method: "POST",
    headers: { Authorization: "Bearer ejemplo" },
    body: JSON.stringify({
      data: { slug: "taberna-lumbre", locationId: "centro", tableId: "S1", token: "a".repeat(43) },
    }),
  })
describe("Puente local de callables", () => {
  it("solo permite los nombres propios y valida la entrada", async () => {
    const fetcher = vi.fn()
    expect((await proxyCallable("borrarTodo", request(), fetcher)).status).toBe(404)
    expect(
      (await proxyCallable("verMesaPublica", new Request("http://localhost", { method: "POST", body: "{}" }), fetcher))
        .status,
    ).toBe(400)
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("expone el 404 sin CORS como función ausente", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response("no existe", { status: 404 }))
    const result = await proxyCallable("verMesaPublica", request(), fetcher)
    expect((await result.json()).error.status).toBe("MISSING")
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:5016/demo-llenamos/europe-west1/verMesaPublica")
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer ejemplo")
    expect(result.headers.get("cache-control")).toBe("no-store")
  })
  it("no convierte permisos denegados en función ausente", async () => {
    const result = await proxyCallable(
      "verMesaPublica",
      request(),
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ error: { status: "PERMISSION_DENIED", message: "Token incorrecto" } }, { status: 403 }),
        ),
    )
    expect(result.status).toBe(403)
    expect((await result.json()).error.status).toBe("PERMISSION_DENIED")
  })
  it("conserva la incertidumbre si falla la conexión", async () => {
    const result = await proxyCallable(
      "verMesaPublica",
      request(),
      vi.fn().mockRejectedValue(new Error("desconectado")),
    )
    expect(result.status).toBe(504)
    expect((await result.json()).error.status).toBe("UNCERTAIN")
  })
})
