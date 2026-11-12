import { act, renderHook, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  subscribeDoc: vi.fn(),
  subscribeQuery: vi.fn(),
}))
vi.mock("./demo-firestore", () => ({ subscribeDoc: mocks.subscribeDoc, subscribeQuery: mocks.subscribeQuery, subscribeDocs: vi.fn() }))
import { useDemoDoc, useDemoQuery } from "./demo-live"

describe("lecturas de la demo con carga diferida del SDK", () => {
  it("con clave nula no carga nada", async () => {
    mocks.subscribeDoc.mockClear()
    const { result } = renderHook(() => useDemoDoc(null, (_id, data) => data))
    await new Promise((r) => setTimeout(r, 10))
    expect(result.current).toEqual({ status: "loading" })
    expect(mocks.subscribeDoc).not.toHaveBeenCalled()
  })

  it("abre el documento, entrega el dato y cancela al desmontar", async () => {
    let emit: { data: (v: unknown) => void; error: (e: unknown) => void } | undefined
    mocks.subscribeDoc.mockImplementation((_path: string, _parse: unknown, e: typeof emit) => { emit = e; return mocks.unsubscribe })
    const { result, unmount } = renderHook(() => useDemoDoc("restaurants/r1", (_id, data) => data))
    await waitFor(() => expect(emit).toBeDefined())
    act(() => emit!.data({ name: "La Taberna" }))
    expect(result.current).toEqual({ status: "ready", data: { name: "La Taberna" } })
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalled()
  })

  it("un cambio de consulta descarta lo anterior y muestra el error de la nueva", async () => {
    const emits: Array<{ data: (v: unknown) => void; error: (e: unknown) => void }> = []
    mocks.subscribeQuery.mockImplementation((_spec: unknown, _parse: unknown, e: (typeof emits)[number]) => { emits.push(e); return () => {} })
    const { result, rerender } = renderHook(({ path }) => useDemoQuery({ path }, (id) => id), { initialProps: { path: "a" } })
    await waitFor(() => expect(emits).toHaveLength(1))
    act(() => emits[0]!.data(["x"]))
    expect(result.current).toMatchObject({ status: "ready" })
    rerender({ path: "b" })
    expect(result.current).toEqual({ status: "loading" })
    await waitFor(() => expect(emits).toHaveLength(2))
    act(() => emits[1]!.error(new Error("sin permiso")))
    expect(result.current).toMatchObject({ status: "error" })
  })
})
