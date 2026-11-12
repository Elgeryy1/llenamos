import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ updateDoc: vi.fn().mockResolvedValue(undefined) }))
vi.mock("firebase/firestore", () => ({
  doc: () => "restaurants/lumbre",
  serverTimestamp: () => "fecha-servidor",
  updateDoc: mocks.updateDoc,
}))
vi.mock("@/lib/api/config", () => ({ dataBackend: () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? "postgres" : "firebase-demo") }))
vi.mock("@/components/proveedores/ProveedoresRestaurante", () => ({ ProveedoresRestaurante: () => <div data-testid="proveedores" /> }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ db: {} }) }))
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({
    user: { uid: "marta" }, role: "owner",
    restaurant: { id: "lumbre", name: "Taberna Lumbre", brandColor: "#f0a35e", locale: "es" },
  }),
}))

import { AjustesView } from "./AjustesView"

it("guarda los ajustes con el uid de la sesión", async () => {
  render(<AjustesView />)
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Taberna nueva" } })
  fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))
  await waitFor(() => expect(mocks.updateDoc).toHaveBeenCalledWith("restaurants/lumbre", {
    name: "Taberna nueva", updatedBy: "marta", updatedAt: "fecha-servidor",
  }))
  expect(await screen.findByText("Cambios guardados.")).toBeTruthy()
})

it("en el VPS guarda con la operación de la API y no toca Firestore", async () => {
  vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
  mocks.updateDoc.mockClear()
  const post = vi.spyOn(await import("@/lib/api/transport"), "postOperation").mockResolvedValue({ ok: true })
  render(<AjustesView />)
  fireEvent.change(screen.getByLabelText("Nombre"), { target: { value: "Otra taberna" } })
  fireEvent.click(screen.getByRole("button", { name: "Guardar cambios" }))
  await waitFor(() => expect(post).toHaveBeenCalledWith("guardarAjustesRestaurante", { restaurantId: "lumbre", name: "Otra taberna" }, expect.objectContaining({ authentication: "required" })))
  expect(await screen.findByText("Cambios guardados.")).toBeTruthy()
  expect(mocks.updateDoc).not.toHaveBeenCalled()
  vi.unstubAllEnvs()
})
