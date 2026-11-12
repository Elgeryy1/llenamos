import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { isTyping, keyOf, useHotkeys, type HotkeyHandler } from "./hotkeys"

function Probe({ bindings, children }: { bindings: Record<string, HotkeyHandler>; children?: React.ReactNode }) {
  useHotkeys(bindings)
  return <>{children}</>
}

describe("atajos del panel", () => {
  it("una tecla suelta lanza su acción", () => {
    const nueva = vi.fn()
    render(<Probe bindings={{ n: nueva }} />)
    fireEvent.keyDown(window, { key: "n" })
    expect(nueva).toHaveBeenCalledTimes(1)
  })

  it("las teclas sueltas no cuentan mientras se escribe en un campo", () => {
    const nueva = vi.fn()
    render(
      <Probe bindings={{ n: nueva }}>
        <input aria-label="Buscar reserva" />
      </Probe>,
    )
    const campo = screen.getByLabelText("Buscar reserva")
    fireEvent.keyDown(campo, { key: "n" })
    expect(nueva).not.toHaveBeenCalled()
    expect(isTyping(campo)).toBe(true)
  })

  it("ni con una ventana abierta; Ctrl K cuenta siempre", () => {
    const nueva = vi.fn()
    const paleta = vi.fn()
    render(
      <Probe bindings={{ n: nueva, "mod+k": paleta }}>
        <div role="dialog" aria-label="Detalle">
          <input aria-label="Nota" />
        </div>
      </Probe>,
    )
    fireEvent.keyDown(window, { key: "n" })
    expect(nueva).not.toHaveBeenCalled()
    fireEvent.keyDown(screen.getByLabelText("Nota"), { key: "k", ctrlKey: true })
    expect(paleta).toHaveBeenCalledTimes(1)
  })

  it("«?» se lee igual con mayúsculas y ⌘ vale como Ctrl", () => {
    expect(keyOf(new KeyboardEvent("keydown", { key: "?", shiftKey: true }))).toBe("?")
    expect(keyOf(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }))).toBe("mod+enter")
    expect(keyOf(new KeyboardEvent("keydown", { key: "J" }))).toBe("j")
  })

  it("se deja de escuchar al ocultar la página (el efecto se limpia)", () => {
    const nueva = vi.fn()
    const { unmount } = render(<Probe bindings={{ n: nueva }} />)
    unmount()
    fireEvent.keyDown(window, { key: "n" })
    expect(nueva).not.toHaveBeenCalled()
  })

  it("deja desplazar la línea de tiempo cuando la página declina la flecha", () => {
    render(<Probe bindings={{ arrowright: () => false, n: () => {} }} />)
    const flecha = new KeyboardEvent("keydown", { key: "ArrowRight", cancelable: true })
    fireEvent(window, flecha)
    expect(flecha.defaultPrevented).toBe(false)
    const nueva = new KeyboardEvent("keydown", { key: "n", cancelable: true })
    fireEvent(window, nueva)
    expect(nueva.defaultPrevented).toBe(true)
  })

  it("deja Ctrl Intro al detalle cuando la pantalla de detrás declina la acción", () => {
    const action = vi.fn()
    render(<>
      <Probe bindings={{ "mod+enter": () => false }} />
      <Probe bindings={{ "mod+enter": action }}><div role="dialog" /></Probe>
    </>)
    fireEvent.keyDown(window, { key: "Enter", ctrlKey: true })
    expect(action).toHaveBeenCalledTimes(1)
  })
})
