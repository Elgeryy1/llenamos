import { act, renderHook } from "@testing-library/react"
import { afterEach, expect, it, vi } from "vitest"
import { linea, T0 } from "../../../../../packages/core/src/sala/datos-prueba"
import { useAvisos } from "./use-avisos"
const lines = [{ id: "demo", ...linea() }]
const due = T0 + 10 * 60_000
const vibrate = vi.fn()
afterEach(() => vi.restoreAllMocks())
it("no vibra al entrar tarde, solo al cruzar el plazo en una pantalla activa", () => {
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true })
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  vibrate.mockClear()
  const { rerender } = renderHook(({ now }) => useAvisos(lines, true, now), { initialProps: { now: due - 1 } })
  expect(vibrate).not.toHaveBeenCalled()
  rerender({ now: due })
  expect(vibrate).toHaveBeenCalledTimes(1)
  rerender({ now: due + 5_000 })
  expect(vibrate).toHaveBeenCalledTimes(1)
})
it("volver de una pestaña oculta no reproduce avisos antiguos", () => {
  Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true })
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible")
  vibrate.mockClear()
  const { rerender } = renderHook(({ now }) => useAvisos(lines, true, now), { initialProps: { now: due - 1 } })
  act(() => document.dispatchEvent(new Event("visibilitychange")))
  rerender({ now: due + 60_000 })
  expect(vibrate).not.toHaveBeenCalled()
})
