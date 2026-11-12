import { fireEvent, render, screen } from "@testing-library/react"
import { expect, it } from "vitest"
import { exampleMenu } from "@/lib/carta/fixtures.test-data"
import { Catalog } from "./Catalog"
it("filtra nombre y descripción, muestra contador, aviso y limpia exclusiones", () => {
  const menu = exampleMenu()
  render(
    <Catalog menu={menu} language="en" channel="table" at={Date.now()} canAdd={false} onAdd={() => {}} />,
  )
  fireEvent.change(screen.getByRole("searchbox", { name: "Search by name or description" }), {
    target: { value: "Croquettes" },
  })
  expect(screen.getByRole("heading", { name: /croquettes/i })).toBeTruthy()
  expect(screen.queryByRole("heading", { name: "Beer" })).toBeNull()
  fireEvent.click(screen.getByLabelText("Milk"))
  expect(screen.queryByRole("heading", { name: /croquettes/i })).toBeNull()
  expect(screen.getByRole("status").textContent).toContain("0 results")
  expect(screen.getByText(/incomplete allergen information/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }))
  expect(screen.getByRole("heading", { name: "Beer" })).toBeTruthy()
})

it("cierra las opciones del plato al excluirlo por alérgenos", () => {
  render(
    <Catalog menu={exampleMenu()} language="en" channel="table" at={Date.now()} canAdd onAdd={() => {}} />,
  )
  fireEvent.click(screen.getAllByRole("button", { name: "Add" })[0]!)
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy()
  fireEvent.click(screen.getByLabelText("Milk"))
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
})
