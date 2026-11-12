import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { expect, it, vi } from "vitest"
import { TecladoPin } from "./TecladoPin"

function Prueba({ onEnter }: { onEnter?: () => void }) {
  const [v, setV] = useState("")
  return (
    <>
      <TecladoPin valor={v} onChange={setV} onEnter={onEnter} />
      <output data-testid="valor">{v}</output>
    </>
  )
}

it("escribe, borra y no pasa de seis cifras; los puntos solo cuentan", () => {
  render(<Prueba />)
  for (const k of "1234567") fireEvent.click(screen.getByRole("button", { name: k }))
  expect(screen.getByTestId("valor").textContent).toBe("123456")
  expect(screen.getByRole("img", { name: "6 de 6 cifras escritas" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Borrar la última cifra" }))
  expect(screen.getByTestId("valor").textContent).toBe("12345")
})

it("acepta el teclado físico y Intro solo con cuatro cifras o más", () => {
  const onEnter = vi.fn()
  render(<Prueba onEnter={onEnter} />)
  const grupo = screen.getByRole("group", { name: "Teclado del PIN" })
  for (const key of ["1", "2", "3"]) fireEvent.keyDown(grupo, { key })
  fireEvent.keyDown(grupo, { key: "Enter" })
  expect(onEnter).not.toHaveBeenCalled()
  fireEvent.keyDown(grupo, { key: "4" })
  fireEvent.keyDown(grupo, { key: "Enter" })
  expect(onEnter).toHaveBeenCalledTimes(1)
  fireEvent.keyDown(grupo, { key: "Backspace" })
  expect(screen.getByTestId("valor").textContent).toBe("123")
})

it("cada tecla mide al menos 64 px de alto para el dedo", () => {
  render(<Prueba />)
  expect(screen.getByRole("button", { name: "5" }).className).toContain("h-16")
})
