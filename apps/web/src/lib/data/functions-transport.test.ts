import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
const mock = vi.hoisted(() => ({ post: vi.fn() }))
vi.mock("@/lib/api/transport", () => ({ postOperation: mock.post }))
vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: false, problems: [] } }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => { throw Error("No debe acceder a Firebase datos") } }))
import { llamarFuncion } from "./functions"
beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); vi.clearAllMocks() })
afterEach(() => vi.unstubAllEnvs())
describe("funciones de miembros en VPS", () => {
  it("acepta invitación sin usar identidad previa y valida output", async () => {
    mock.post.mockResolvedValue({ ok: true, email: "persona@example.test" })
    const input = { invitationId: "a".repeat(64), token: "b".repeat(43), password: "secret-strong-123" }
    await expect(llamarFuncion("aceptarInvitacion", input)).resolves.toEqual({ ok: true, email: "persona@example.test" })
    expect(mock.post).toHaveBeenCalledWith("aceptarInvitacion", input, { authentication: "none", timeoutMs: 20_000 })
    mock.post.mockResolvedValue({ ok: true, email: "invalido" })
    await expect(llamarFuncion("aceptarInvitacion", input)).rejects.toThrow()
  })
  it("invitar exige identidad y no acepta password elegido por otro", async () => {
    mock.post.mockResolvedValue({ uid: "u1", invitationStatus: "pending" })
    const input = { restaurantId: "r1", email: "persona@example.test", displayName: "Persona", role: "waiter" as const }
    await llamarFuncion("invitarMiembro", input)
    expect(mock.post).toHaveBeenCalledWith("invitarMiembro", input, { authentication: "required", timeoutMs: 20_000 })
    await expect(llamarFuncion("invitarMiembro", { ...input, password: "invitador" } as never)).rejects.toThrow()
    expect(mock.post).toHaveBeenCalledOnce()
  })
  it("fallo o endpoint no migrado no intenta Firebase", async () => {
    mock.post.mockRejectedValue(new Error("not-deployed"))
    await expect(llamarFuncion("desactivarMiembro", { restaurantId: "r1", uid: "u1" })).rejects.toThrow("not-deployed")
    expect(mock.post).toHaveBeenCalledOnce()
  })
})
