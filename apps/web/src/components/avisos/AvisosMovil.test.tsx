import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"
const mocks = vi.hoisted(() => ({ call: vi.fn(), permission: vi.fn(), subscribe: vi.fn(), register: vi.fn(), getRegistration: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: () => ({ role: "waiter", restaurant: { id: "r", plan: "sala" }, location: { id: "l" }, user: { uid: "u" } }) }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => ({ functions: {}, db: {} }) }))
vi.mock("@/lib/api/operations", () => ({ operationBackend: () => "firebase-demo", invokeOperation: async (name: string, data: unknown) => (await mocks.call(name, data)).data }))
vi.mock("firebase/firestore", () => ({ collection: vi.fn(), query: vi.fn(), where: vi.fn(), onSnapshot: () => vi.fn() }))
import { AvisosMovil } from "./AvisosMovil"

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(window, "isSecureContext", { configurable: true, value: true })
  Object.defineProperty(window, "PushManager", { configurable: true, value: class {} })
  Object.defineProperty(window, "Notification", { configurable: true, value: { requestPermission: mocks.permission } })
  mocks.permission.mockResolvedValue("granted")
  mocks.getRegistration.mockResolvedValue(undefined)
  const registration = { active: { state: "activated" }, pushManager: { subscribe: mocks.subscribe, getSubscription: vi.fn().mockResolvedValue(null) } }
  mocks.register.mockResolvedValue(registration)
  // En /panel la promesa global ready no se resuelve para el ámbito /panel/.
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: { register: mocks.register, getRegistration: mocks.getRegistration, ready: new Promise(() => {}) } })
})
it("sin VAPID lo dice y no solicita permiso ni crea suscripciones", async () => {
  mocks.call.mockResolvedValue({ data: { configured: false, publicKey: null, localCapture: true, subscribedEndpoints: [] } })
  render(<AvisosMovil />)
  fireEvent.click(screen.getByText(/Avisos al móvil/))
  await screen.findByText("Sin claves VAPID válidas no se envía nada al móvil.")
  expect((screen.getByRole("button", { name: "Probar permiso en local" }) as HTMLButtonElement).disabled).toBe(true)
  expect(mocks.permission).not.toHaveBeenCalled(); expect(mocks.subscribe).not.toHaveBeenCalled()
})
it("en local prueba consentimiento y trabajador sin llamar al servicio externo de push", async () => {
  mocks.call.mockResolvedValue({ data: { configured: true, publicKey: "AQAB", localCapture: true, subscribedEndpoints: [] } })
  render(<AvisosMovil />)
  fireEvent.click(screen.getByText(/Avisos al móvil/))
  const button = await screen.findByRole("button", { name: "Probar permiso en local" })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
  await screen.findByText(/Permiso concedido y trabajador registrado/)
  expect(mocks.register).toHaveBeenCalledWith("/sw-plataforma.js", { scope: "/panel/" })
  expect(mocks.permission).toHaveBeenCalledOnce(); expect(mocks.subscribe).not.toHaveBeenCalled()
})

it("renueva la suscripción cuando cambia la clave VAPID y guarda solo las claves del navegador", async () => {
  const oldSubscription = { options: { applicationServerKey: Uint8Array.from([9, 9, 9]).buffer }, unsubscribe: vi.fn().mockResolvedValue(true) }
  const subscription = { endpoint: "https://fcm.googleapis.com/fcm/send/local", toJSON: () => ({ keys: { p256dh: "publica", auth: "autenticacion" } }), unsubscribe: vi.fn() }
  mocks.getRegistration.mockResolvedValue({ pushManager: { getSubscription: vi.fn().mockResolvedValue(null) } })
  mocks.register.mockResolvedValue({ active: { state: "activated" }, pushManager: { getSubscription: vi.fn().mockResolvedValue(oldSubscription), subscribe: mocks.subscribe } })
  mocks.subscribe.mockResolvedValue(subscription)
  mocks.call.mockImplementation((name: string) => Promise.resolve({ data: name === "configuracionPush" ? { configured: true, publicKey: "AQAB", localCapture: false, subscribedEndpoints: [] } : { ok: true } }))
  render(<AvisosMovil />)
  fireEvent.click(screen.getByText(/Avisos al móvil/))
  const button = await screen.findByRole("button", { name: "Activar avisos en este móvil" })
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(button)
  await screen.findByText(/Avisos activados para este local/)
  expect(oldSubscription.unsubscribe).toHaveBeenCalledOnce()
  expect(mocks.subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: Uint8Array.from([1, 0, 1]) })
  expect(mocks.call).toHaveBeenCalledWith("guardarSuscripcionPush", { restaurantId: "r", locationId: "l", enabled: true, subscription: { endpoint: subscription.endpoint, keys: subscription.toJSON().keys } })
})
