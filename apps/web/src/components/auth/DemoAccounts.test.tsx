import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { DEMO_ACCOUNTS } from "@/lib/demo"
import { DemoAccounts } from "./DemoAccounts"

describe("DemoAccounts", () => {
  it("lista las seis cuentas del contrato", () => {
    render(<DemoAccounts onPick={() => {}} pendingEmail={null} />)
    expect(screen.getAllByRole("button")).toHaveLength(6)
    expect(DEMO_ACCOUNTS.map((a) => a.email)).toEqual([
      "propietario@lumbre.test",
      "encargada@lumbre.test",
      "camarero@lumbre.test",
      "camarera@lumbre.test",
      "cocina@lumbre.test",
      "barra@lumbre.test",
    ])
  })

  it("entra con la cuenta elegida", () => {
    const onPick = vi.fn()
    render(<DemoAccounts onPick={onPick} pendingEmail={null} />)
    fireEvent.click(screen.getByRole("button", { name: "Entrar como encargado con encargada@lumbre.test" }))
    expect(onPick).toHaveBeenCalledWith({ email: "encargada@lumbre.test", role: "manager" })
  })

  it("marca la cuenta con la que se está entrando", () => {
    render(<DemoAccounts onPick={() => {}} pendingEmail="cocina@lumbre.test" disabled />)
    const button = screen.getByRole("button", { name: /cocina@lumbre.test/ })
    expect(button.getAttribute("aria-busy")).toBe("true")
    expect(button.hasAttribute("disabled")).toBe(true)
  })
})
