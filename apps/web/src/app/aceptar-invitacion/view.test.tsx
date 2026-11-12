import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  replace: vi.fn(),
  llamar: vi.fn(),
  signOut: vi.fn(),
  signIn: vi.fn(),
  getIdToken: vi.fn(),
  order: [] as string[],
}))

vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: mocks.replace }) }))
vi.mock("firebase/auth", () => ({ signOut: mocks.signOut, signInWithEmailAndPassword: mocks.signIn }))
vi.mock("@/lib/firebase/auth-client", () => ({ getFirebaseIdentity: () => ({ auth: { app: "real" } }) }))
vi.mock("@/lib/data/functions", () => ({ llamarFuncion: mocks.llamar }))

const { AcceptInvitation } = await import("./view")
const id = "a".repeat(64), token = "T".repeat(43)

function fill(password: string, repeat = password) {
  fireEvent.change(screen.getByLabelText("Nueva contraseña"), { target: { value: password } })
  fireEvent.change(screen.getByLabelText("Repetir contraseña"), { target: { value: repeat } })
}
const submit = () => act(async () => { fireEvent.click(screen.getByRole("button", { name: "Aceptar invitación y entrar" })) })

describe("AcceptInvitation", () => {
  beforeEach(() => {
    mocks.order.length = 0
    mocks.replace.mockReset()
    mocks.signOut.mockReset().mockImplementation(async () => { mocks.order.push("signOut") })
    mocks.llamar.mockReset().mockImplementation(async () => { mocks.order.push("aceptar"); return { ok: true, email: "jefa@restaurante.test" } })
    mocks.getIdToken.mockReset().mockResolvedValue("token")
    mocks.signIn.mockReset().mockImplementation(async () => { mocks.order.push("signIn"); return { user: { getIdToken: mocks.getIdToken } } })
    window.location.hash = `#i=${id}&t=${token}`
  })

  it("no envía nada si la contraseña es corta o no coincide", async () => {
    render(<AcceptInvitation />)
    fill("corta"); await submit()
    expect(screen.getByText(/al menos 12 caracteres/)).toBeTruthy()
    fill("una-contraseña-larga", "otra-distinta-larga"); await submit()
    expect(mocks.llamar).not.toHaveBeenCalled()
  })

  it("cierra la sesión anterior, acepta con el token del enlace y entra con la contraseña elegida", async () => {
    render(<AcceptInvitation />)
    fill("una-contraseña-larga"); await submit()
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/panel"))
    expect(mocks.order).toEqual(["signOut", "aceptar", "signIn"])
    expect(mocks.llamar).toHaveBeenCalledWith("aceptarInvitacion", { invitationId: id, token, password: "una-contraseña-larga" })
    expect(mocks.signIn).toHaveBeenCalledWith({ app: "real" }, "jefa@restaurante.test", "una-contraseña-larga")
    expect(mocks.getIdToken).toHaveBeenCalledWith(true)
  })

  it("si el servidor rechaza el enlace no abre sesión y lo explica", async () => {
    mocks.llamar.mockRejectedValueOnce(new Error("invalid"))
    render(<AcceptInvitation />)
    fill("una-contraseña-larga"); await submit()
    expect(await screen.findByText(/No se ha podido aceptar la invitación/)).toBeTruthy()
    expect(mocks.signIn).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })
})
