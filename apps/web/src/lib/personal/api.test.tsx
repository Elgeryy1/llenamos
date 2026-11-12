vi.mock("@/lib/firebase/config", () => ({ firebaseConfig: { ok: true, settings: { options: { projectId: "demo-llenamos" }, emulators: {} } } }))
import { act, renderHook } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

const llamada = vi.fn()
vi.mock("firebase/functions", () => ({ httpsCallable: () => (data: unknown) => llamada(data) }))
vi.mock("@/lib/firebase/client", async (original) => ({ ...(await original<typeof import("@/lib/firebase/client")>()), getFirebase: () => ({ functions: {} }) }))

import { errorPersonal, esIncierto, intentosRestantes, useAccionPersonal } from "./api"

const scope = { restaurantId: "demo", locationId: "centro" }
const salida = { entryId: "e1", state: "working", at: 1_700_000_000_000, workedMinutes: null }

beforeEach(() => { llamada.mockReset() })

it("una operación sin respuesta se repite con el mismo requestId y la siguiente, con otro", async () => {
  llamada.mockRejectedValueOnce(Object.assign(new Error("unavailable"), { code: "functions/unavailable" }))
  llamada.mockResolvedValue({ data: salida })
  const { result } = renderHook(() => useAccionPersonal(scope))
  const r1 = await act(() => result.current.ejecutar("fichar", { action: "in", note: null }))
  expect(r1).toMatchObject({ ok: false })
  const r2 = await act(() => result.current.ejecutar("fichar", { action: "in", note: null }))
  expect(r2).toMatchObject({ ok: true })
  expect(llamada.mock.calls[1]![0].requestId).toBe(llamada.mock.calls[0]![0].requestId)
  await act(() => result.current.ejecutar("fichar", { action: "break_start", note: null }))
  expect(llamada.mock.calls[2]![0].requestId).not.toBe(llamada.mock.calls[0]![0].requestId)
})

it("un error definitivo no conserva el requestId", async () => {
  llamada.mockRejectedValueOnce(Object.assign(new Error("Ya tienes el fichaje abierto."), { code: "functions/failed-precondition" }))
  llamada.mockResolvedValue({ data: salida })
  const { result } = renderHook(() => useAccionPersonal(scope))
  const r1 = await act(() => result.current.ejecutar("fichar", { action: "in", note: null }))
  expect(r1).toMatchObject({ ok: false, message: "Ya tienes el fichaje abierto." })
  await act(() => result.current.ejecutar("fichar", { action: "in", note: null }))
  expect(llamada.mock.calls[1]![0].requestId).not.toBe(llamada.mock.calls[0]![0].requestId)
})

it("un doble toque no lanza dos llamadas", async () => {
  let fin!: (v: unknown) => void
  llamada.mockReturnValue(new Promise((r) => { fin = r }))
  const { result } = renderHook(() => useAccionPersonal(scope))
  let primera!: Promise<unknown>
  let segunda: unknown
  await act(async () => {
    primera = result.current.ejecutar("fichar", { action: "in", note: null })
    segunda = await result.current.ejecutar("fichar", { action: "in", note: null })
  })
  expect(segunda).toBeNull()
  fin({ data: salida })
  await act(async () => { await primera })
  expect(llamada).toHaveBeenCalledTimes(1)
})

it("no manda nada sin conexión y lo dice", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
  const { result } = renderHook(() => useAccionPersonal(scope))
  const r = await act(() => result.current.ejecutar("fichar", { action: "in", note: null }))
  expect(r).toMatchObject({ ok: false, message: "Necesitas conexión para esto. No se ha guardado nada." })
  expect(llamada).not.toHaveBeenCalled()
  online.mockRestore()
})

it("la entrada no lleva hora: fichar es siempre con el reloj del servidor", async () => {
  llamada.mockResolvedValue({ data: salida })
  const { result } = renderHook(() => useAccionPersonal(scope))
  await act(() => result.current.ejecutar("fichar", { action: "in", note: null }))
  const enviado = llamada.mock.calls[0]![0]
  expect(Object.keys(enviado).sort()).toEqual(["action", "locationId", "note", "requestId", "restaurantId"])
})

it("clasifica errores y limpia el código HTTP del mensaje", () => {
  expect(esIncierto({ code: "functions/unavailable" })).toBe(true)
  expect(esIncierto({ code: "functions/permission-denied" })).toBe(false)
  expect(esIncierto(new Error("sin código"))).toBe(false)
  expect(intentosRestantes({ details: { attemptsLeft: 3 } })).toBe(3)
  expect(intentosRestantes(new Error("x"))).toBeNull()
  expect(errorPersonal(new Error("PIN incorrecto. Te quedan 4 intentos. [403]"))).toBe("PIN incorrecto. Te quedan 4 intentos.")
})
