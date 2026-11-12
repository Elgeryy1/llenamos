import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ live: vi.fn(), consulta: vi.fn(() => ({ status: "loading" })) }))
vi.mock("@/lib/api/live", () => ({ useLiveQuery: mocks.live }))
vi.mock("./datos-demo", () => ({ useConsulta: mocks.consulta }))
const scope = { restaurantId: "r", locationId: "l" }
const pago = { billId: "b", partId: "p", cashSessionId: "c", kind: "charge", originalPaymentId: null, method: "cash", status: "succeeded", amountCents: 100, tipCents: 0, tenderedCents: 100, changeCents: 0, externalId: null, requestId: "q", reason: null, at: 1700000000000, by: "u", id: "pay1" }

describe("lecturas de caja en el VPS", () => {
  beforeEach(() => { vi.resetModules(); vi.clearAllMocks(); vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres") })
  afterEach(() => vi.unstubAllEnvs())
  it("usa las LiveQuery de la API y no abre ninguna suscripción de Firestore", async () => {
    mocks.live.mockImplementation((name: string, input: unknown) => (input === null ? { status: "loading" } : { status: "ready", data: { payments: [pago], movements: [], distributions: [] } }))
    const { usePagos } = await import("./datos")
    const { result } = renderHook(() => usePagos(scope, "cashSessionId", "c"))
    expect(result.current).toEqual({ status: "ready", data: [pago], fresh: true })
    expect(mocks.live).toHaveBeenCalledWith("cajaTurno", { ...scope, cashSessionId: "c" }, expect.anything())
    for (const call of mocks.consulta.mock.calls as unknown as unknown[][]) expect(call[0]).toBeNull()
  })
  it("sin despliegue de lectura en vivo muestra el error, no datos inventados", async () => {
    const error = new Error("not-deployed")
    mocks.live.mockReturnValue({ status: "error", error })
    const { useCuentas } = await import("./datos")
    expect(renderHook(() => useCuentas(scope)).result.current).toEqual({ status: "error", error })
  })
  it("mesas y recogidas abiertas salen del servicio de sala; las cerradas no se ofrecen", async () => {
    const sesion = (id: string, status: string) => ({ id, status, label: id, guestName: null })
    const recogida = (id: string, status: string) => ({ id, status })
    mocks.live.mockImplementation((name: string, input: unknown) => (input === null ? { status: "loading" } : name === "salaServicio"
      ? { status: "ready", data: { sessions: [sesion("a", "open"), sesion("b", "closed"), sesion("c", "bill_requested")], orders: [], lines: [], tasks: [], takeaways: [recogida("r1", "pending"), recogida("r2", "done")], truncated: false } }
      : { status: "loading" }))
    const { useMesasCaja, useRecogidasCaja } = await import("./datos")
    expect(renderHook(() => useMesasCaja(scope)).result.current).toMatchObject({ status: "ready", data: [{ id: "a" }, { id: "c" }], fresh: true })
    expect(renderHook(() => useRecogidasCaja(scope)).result.current).toMatchObject({ status: "ready", data: [{ id: "r1" }] })
    expect(mocks.live).toHaveBeenCalledWith("salaServicio", scope, expect.anything())
  })
  it("el equipo y las incidencias de cobro móvil se leen de la API, con permiso", async () => {
    mocks.live.mockImplementation((name: string, input: unknown) => {
      if (input === null) return { status: "loading" }
      if (name === "cajaEquipo") return { status: "ready", data: { members: [{ id: "u1", displayName: "Ana" }] } }
      if (name === "cajaIncidencias") return { status: "ready", data: { incidents: [{ id: "i1", summary: "Revisar", status: "open" }] } }
      return { status: "loading" }
    })
    const { useEquipoCaja, useIncidenciasMoviles } = await import("./datos")
    expect(renderHook(() => useEquipoCaja(scope, true)).result.current).toMatchObject({ status: "ready", data: [{ id: "u1", displayName: "Ana" }] })
    expect(renderHook(() => useIncidenciasMoviles(scope, true)).result.current).toMatchObject({ status: "ready", data: [{ id: "i1" }] })
    // Sin permiso no se pide nada al servidor.
    expect(renderHook(() => useIncidenciasMoviles(scope, false)).result.current).toEqual({ status: "loading" })
    expect(renderHook(() => useEquipoCaja(scope, false)).result.current).toMatchObject({ status: "ready", data: [] })
  })
  it("el código de datos de caja e impresión no importa Firebase de forma estática: la demo lo carga con import() dinámico", async () => {
    const { readFileSync } = await import("node:fs"), { resolve } = await import("node:path")
    const read = (file: string) => readFileSync(resolve(process.cwd(), "src/lib/caja", file), "utf8")
    for (const file of ["datos.ts", "datos-demo.ts", "restricciones.ts", "../impresion/datos.ts"]) {
      const source = read(file)
      expect(source, file).not.toMatch(/^\s*import[^\n]*from\s+["']firebase\//m)
      expect(source, file).not.toMatch(/from\s+["']@\/lib\/firebase\/(live|client|storage)["']/)
    }
    // El import() dinámico depende de una constante de compilación: con `postgres` es null y no entra en el paquete.
    const demo = read("datos-demo.ts")
    expect(demo).toMatch(/NEXT_PUBLIC_DATA_BACKEND === "postgres" \? null : \(\) =>/)
    for (const line of demo.split("\n").filter(l => /import\(/.test(l) && !l.trim().startsWith("*"))) {
      expect(line).toMatch(/const cargarDemo = /)
    }
  })
})
