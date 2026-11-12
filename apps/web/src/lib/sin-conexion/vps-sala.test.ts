import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ queue: vi.fn(), invoke: vi.fn(), can: vi.fn() }))
vi.mock("@/lib/sin-conexion/cliente", () => ({ queueOperation: mocks.queue, puedeEncolar: mocks.can }))
vi.mock("@/lib/api/operations", async (original) => ({ ...(await original<typeof import("@/lib/api/operations")>()), invokeOperation: mocks.invoke }))

const alcance = { restaurantId: "r", locationId: "l" }

describe("sala y cocina en el VPS usan la cola sin conexión del servicio sync", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    mocks.queue.mockReset(); mocks.invoke.mockReset(); mocks.can.mockReset().mockResolvedValue(true)
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
  })
  it("los cambios de estado de platos de cocina se encolan y se validan con el contrato", async () => {
    mocks.queue.mockResolvedValue({ ok: true, lines: [{ id: "l1", status: "preparing" }], firedNext: [] })
    const { llamarCocina } = await import("@/lib/cocina/callables")
    expect(await llamarCocina("cambiarEstadoLineas", { ...alcance, lineIds: ["l1"], status: "preparing" })).toMatchObject({ ok: true })
    expect(mocks.queue).toHaveBeenCalledWith("cambiarEstadoLineas", expect.objectContaining({ lineIds: ["l1"], status: "preparing" }))
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
  it("las raciones de cocina siguen siendo una operación en línea directa", async () => {
    mocks.invoke.mockResolvedValue({ ok: true })
    const { llamarCocina } = await import("@/lib/cocina/callables")
    await llamarCocina("guardarRaciones", { ...alcance, itemId: "i", remaining: 3 })
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith("guardarRaciones", expect.anything())
  })
  it("sala encola sus cinco intenciones y manda el resto directo a la API", async () => {
    mocks.queue.mockResolvedValue({ result: "ok", status: "claimed", claimedBy: "u", claimedByName: null })
    mocks.invoke.mockResolvedValue({ sessionId: "s1", label: "S1", joinable: true, reservationSeated: false })
    const { llamarSala } = await import("@/lib/comandero/callables")
    await llamarSala("cambiarEstadoTarea", { ...alcance, taskId: "t1", action: "claim" })
    expect(mocks.queue).toHaveBeenCalledWith("cambiarEstadoTarea", expect.objectContaining({ taskId: "t1" }))
    await llamarSala("abrirMesa", { ...alcance, tableIds: ["t1"], guests: 2 })
    expect(mocks.invoke).toHaveBeenCalledWith("abrirMesa", expect.objectContaining({ tableIds: ["t1"] }))
    expect(mocks.queue).toHaveBeenCalledTimes(1)
  })
  it("sin versión preparada una intención con conexión va directa a la API", async () => {
    mocks.can.mockResolvedValue(false)
    mocks.invoke.mockResolvedValue({ ok: true, soldOut: true })
    const { llamarSala } = await import("@/lib/comandero/callables")
    await llamarSala("marcarAgotado", { ...alcance, itemId: "i", soldOut: true })
    expect(mocks.queue).not.toHaveBeenCalled()
    expect(mocks.invoke).toHaveBeenCalledWith("marcarAgotado", expect.anything())
  })
  it("sin conexión una operación que no es de la cola no se envía y lo dice", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const { llamarSala } = await import("@/lib/comandero/callables")
    await expect(llamarSala("abrirMesa", { ...alcance, tableIds: ["t1"], guests: 2 })).rejects.toThrow(/conexión/)
    expect(mocks.invoke).not.toHaveBeenCalled()
  })
})
