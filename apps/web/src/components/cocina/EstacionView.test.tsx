vi.mock("@/components/sin-conexion/ColaServicio", () => ({ ColaServicio: () => null }))
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
import { FirebaseError } from "firebase/app"
import { demoMenu, OrderLineSchema, MenuItemSchema } from "@llenamos/core"
import { linea, T0 } from "../../../../../packages/core/src/sala/datos-prueba"

// Todos estos documentos son ejemplos de core, solo para pruebas de componentes.
const { panel, datos, llamar, serverRead } = vi.hoisted(() => ({ panel: vi.fn(), datos: vi.fn(), llamar: vi.fn(), serverRead: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: panel }))
vi.mock("@/lib/cocina/datos", () => ({
  useDatosEstaciones: datos,
  useLineasEstacion: () => ({ status: "ready", cached: false, data: [{ id: "demo-l1", ...linea() }] }),
  usePlatosEstacion: () => ({ status: "ready", data: [] }),
  leerDocumento: (schema: typeof OrderLineSchema | typeof MenuItemSchema, _path: string, data: unknown) => schema.parse(data),
}))
vi.mock("@/lib/cocina/datos-demo", () => ({ consultaLineas: vi.fn() }))
vi.mock("@/lib/data/hooks", () => ({ useSala: () => ({ status: "ready", data: { tables: [], areas: [] } }) }))
vi.mock("@/lib/use-now", () => ({ useNow: () => new Date(T0) }))
vi.mock("@/lib/cocina/callables", () => ({ llamarCocina: llamar, errorCocina: (error: Error) => error.message }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ db: {} }) }))
vi.mock("firebase/firestore", () => ({ getDocsFromServer: serverRead, collection: vi.fn(), query: vi.fn() }))
import { EstacionView } from "./EstacionView"

beforeEach(() => {
  vi.clearAllMocks()
  panel.mockReturnValue({ role: "kitchen", user: { uid: "demo-cocina" }, restaurant: { id: "demo-lumbre", timezone: "Europe/Madrid", activeModules: ["floor", "kitchen"], plan: "sala" }, location: { id: "centro", name: "Centro" } })
  const menu = demoMenu()
  datos.mockReturnValue({ stations: { status: "ready", data: [{ id: "cocina", name: "Cocina", kind: "kitchen", active: true, pickup: true, targetMinutes: 10, sortOrder: 0 }] }, settings: { status: "ready", data: menu.settings } })
  serverRead.mockResolvedValue({ docs: [] })
})

it("comprueba el rol y los módulos antes de suscribirse a datos", () => {
  const original = panel()
  panel.mockReturnValue({ ...original, role: "bar" })
  const { rerender } = render(<EstacionView kind="kitchen" />)
  expect(screen.getByText("No tienes acceso a esta estación")).toBeTruthy()
  expect(datos).not.toHaveBeenCalled()
  panel.mockReturnValue({ ...original, restaurant: { ...original.restaurant, activeModules: ["kitchen"] } })
  rerender(<EstacionView kind="kitchen" />)
  expect(screen.getByText("Cocina y sala deben estar activas")).toBeTruthy()
  expect(datos).not.toHaveBeenCalled()
})
it("bloquea el doble toque hasta recibir respuesta", async () => {
  let finish!: () => void
  llamar.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve }))
  render(<EstacionView kind="kitchen" />)
  const button = screen.getByRole("button", { name: "Empezar" })
  fireEvent.click(button)
  fireEvent.click(button)
  expect(llamar).toHaveBeenCalledTimes(1)
  expect(llamar).toHaveBeenCalledWith("cambiarEstadoLineas", { restaurantId: "demo-lumbre", locationId: "centro", lineIds: ["demo-l1"], status: "preparing" })
  await act(async () => finish())
})
it("una respuesta incierta requiere una consulta confirmada antes de permitir otro cambio", async () => {
  llamar.mockRejectedValue(new FirebaseError("functions/deadline-exceeded", "Respuesta incierta"))
  render(<EstacionView kind="kitchen" />)
  fireEvent.click(screen.getByRole("button", { name: "Empezar" }))
  await screen.findByText("Hay que comprobar el estado")
  expect((screen.getByRole("button", { name: "Listo" }) as HTMLButtonElement).disabled).toBe(true)
  serverRead.mockRejectedValueOnce(new Error("Sin conexión"))
  fireEvent.click(screen.getByRole("button", { name: "Comprobar estado" }))
  await screen.findByText("Sin conexión")
  expect((screen.getByRole("button", { name: "Listo" }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(screen.getByRole("button", { name: "Comprobar estado" }))
  await waitFor(() => expect((screen.getByRole("button", { name: "Listo" }) as HTMLButtonElement).disabled).toBe(false))
  expect(llamar).toHaveBeenCalledTimes(1)
})
