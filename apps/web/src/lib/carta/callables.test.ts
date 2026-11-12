import { describe, it, expect, vi } from "vitest"
import { CALLABLE_SCHEMAS } from "@llenamos/core"
import { callService } from "./callables"
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
vi.mock("@/lib/firebase/auth-client", () => ({
  getFirebaseIdentity: () => ({ auth: { currentUser: { getIdToken: async () => "token-de-prueba" } } }),
}))
const input = { slug: "taberna-lumbre", locationId: "centro", tableId: "S1", token: "a".repeat(43) }
describe("Callables reales y validadas", () => {
  it("valida antes de hacer la petición", async () => {
    const fetcher = vi.fn()
    await expect(callService("verMesaPublica", { ...input, token: "" }, false, fetcher)).rejects.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("distingue función ausente y enlace inexistente", async () => {
    await expect(
      callService(
        "verMesaPublica",
        input,
        false,
        vi.fn().mockResolvedValue(new Response("No existe", { status: 404 })),
      ),
    ).rejects.toMatchObject({ code: "missing" })
    await expect(
      callService(
        "verMesaPublica",
        input,
        false,
        vi
          .fn()
          .mockResolvedValue(
            Response.json({ error: { status: "NOT_FOUND", message: "El enlace no es válido." } }, { status: 404 }),
          ),
      ),
    ).rejects.toMatchObject({ code: "not-found", message: "El enlace no es válido." })
  })
  it("no simula éxito con una salida que no cumple el esquema", async () => {
    await expect(
      callService("verMesaPublica", input, false, vi.fn().mockResolvedValue(Response.json({ result: { ok: true } }))),
    ).rejects.toMatchObject({ code: "contract" })
  })
  it("trata una desconexión y un error interno como respuesta incierta", async () => {
    await expect(
      callService("verMesaPublica", input, false, vi.fn().mockRejectedValue(new TypeError("sin red"))),
    ).rejects.toMatchObject({ code: "uncertain" })
    await expect(
      callService(
        "verMesaPublica",
        input,
        false,
        vi.fn().mockResolvedValue(Response.json({ error: { status: "INTERNAL" } }, { status: 500 })),
      ),
    ).rejects.toMatchObject({ code: "uncertain" })
  })
  it("envía la autoría con Auth y usa el contrato de core", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ result: { ok: true, categoryId: "c" } }))
    const category = {
      name: { es: "Bebidas", ca: "", en: "" },
      description: { es: "", ca: "", en: "" },
      sortOrder: 0,
      active: true,
    }
    const request = { restaurantId: "demo-lumbre", locationId: "centro", categoryId: null, category }
    await expect(callService("guardarCategoriaCarta", request, true, fetcher)).resolves.toEqual({
      ok: true,
      categoryId: "c",
    })
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer token-de-prueba")
    expect(JSON.parse(fetcher.mock.calls[0][1].body).data).toEqual(
      CALLABLE_SCHEMAS.guardarCategoriaCarta.input.parse(request),
    )
  })
})
