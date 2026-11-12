import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { useAtribucion } from "./useAtribucion"

afterEach(() => {
  vi.restoreAllMocks()
  window.history.replaceState(null, "", "/")
})
describe("atribución de la visita", () => {
  it("lee campaña y anuncio sin conservar los valores de clic", async () => {
    window.history.replaceState(null, "", "/r/lumbre?llc=otono&utm_source=instagram&fbclid=SECRETO&utm_id=cena")
    const { result } = renderHook(() => useAtribucion())
    await waitFor(() => expect(result.current?.campaignId).toBe("otono"))
    expect(result.current).toMatchObject({ adId: "cena", clickIds: ["fbclid"], utmSource: "instagram", embedHost: null })
    expect(JSON.stringify(result.current)).not.toContain("SECRETO")
  })
  it("obtiene el dominio del padre del referente de un widget", async () => {
    vi.spyOn(document, "referrer", "get").mockReturnValue("https://restaurante.example/carta?privado=1")
    const { result } = renderHook(() => useAtribucion({ widget: true }))
    await waitFor(() => expect(result.current?.embedHost).toBe("restaurante.example"))
    expect(result.current?.referrer).toBe("https://restaurante.example")
  })
  it("admite el mensaje del padre y rechaza otro emisor o un dominio falsificado", async () => {
    const padre = { postMessage: vi.fn() } as unknown as Window
    vi.spyOn(window, "parent", "get").mockReturnValue(padre)
    vi.spyOn(document, "referrer", "get").mockReturnValue("")
    const { result } = renderHook(() => useAtribucion({ widget: true }))
    await waitFor(() => expect(result.current).not.toBeNull())
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://restaurante.example",
          source: window,
          data: { type: "llenamos:attribution", embedHost: "restaurante.example" },
        }),
      ),
    )
    expect(result.current?.embedHost).toBeNull()
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://otro.example",
          source: padre,
          data: { type: "llenamos:attribution", embedHost: "restaurante.example" },
        }),
      ),
    )
    expect(result.current?.embedHost).toBeNull()
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: "https://restaurante.example",
          source: padre,
          data: { type: "llenamos:attribution", embedHost: "restaurante.example" },
        }),
      ),
    )
    expect(result.current?.embedHost).toBe("restaurante.example")
  })
  it("los parámetros demasiado largos no impiden capturar la visita", async () => {
    window.history.replaceState(null, "", `/r/lumbre?utm_source=${"x".repeat(101)}`)
    const { result } = renderHook(() => useAtribucion())
    await waitFor(() => expect(result.current?.landingPath).toBe("/r/lumbre"))
  })
})
