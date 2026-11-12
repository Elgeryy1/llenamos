import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { initializeApp } from "firebase/app"
import { collection, getFirestore, query, queryEqual, where } from "firebase/firestore"
import { OrderLineSchema } from "@llenamos/core"
import { linea } from "../../../../../packages/core/src/sala/datos-prueba"
const { subscribe } = vi.hoisted(() => ({ subscribe: vi.fn() }))
vi.mock("firebase/firestore", async (original) => ({ ...await original<typeof import("firebase/firestore")>(), onSnapshot: subscribe }))
const db = getFirestore(initializeApp({ projectId: "demo-llenamos" }, "pruebas-cocina"))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ db }) }))
import { leerDocumento, useLineasEstacion } from "./datos"
import { consultaLineas } from "./datos-demo"
const base = "restaurants/demo-lumbre/locations/centro"
beforeEach(() => subscribe.mockReset())

it("la consulta restringe tipo, estación y estados antes de llegar a las reglas", () => {
  const expected = query(collection(db, `${base}/orderLines`), where("stationId", "==", "cocina"), where("stationKind", "==", "kitchen"), where("status", "in", ["held", "fired", "preparing", "ready"]))
  expect(queryEqual(consultaLineas(db, base, "cocina", "kitchen"), expected)).toBe(true)
})
it("cancela el listener al cambiar de estación y oculta los tickets anteriores", async () => {
  const unsubscribe = vi.fn()
  subscribe.mockReturnValue(unsubscribe)
  const { result, rerender, unmount } = renderHook(({ id }) => useLineasEstacion(base, id, "kitchen", 0), { initialProps: { id: "cocina" } })
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  const receive = subscribe.mock.calls[0]![2]
  act(() => receive({ docs: [{ id: "l1", data: () => linea() }], metadata: { fromCache: false } }))
  expect(result.current.status).toBe("ready")
  rerender({ id: "horno" })
  expect(unsubscribe).toHaveBeenCalledOnce()
  expect(result.current.status).toBe("loading")
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(2))
  unmount()
  expect(unsubscribe).toHaveBeenCalledTimes(2)
})
it("distingue una copia local y no oculta documentos incorrectos", async () => {
  subscribe.mockReturnValue(vi.fn())
  const { result } = renderHook(() => useLineasEstacion(base, "cocina", "kitchen", 0))
  await waitFor(() => expect(subscribe).toHaveBeenCalledTimes(1))
  const receive = subscribe.mock.calls[0]![2]
  act(() => receive({ docs: [], metadata: { fromCache: true } }))
  expect(result.current.cached).toBe(true)
  act(() => receive({ docs: [{ id: "rota", data: () => ({ status: "ready" }) }], metadata: { fromCache: false } }))
  expect(result.current.status).toBe("error")
  expect(() => leerDocumento(OrderLineSchema, `${base}/orderLines/rota`, { status: "ready" })).toThrow("orderLines/rota")
})
