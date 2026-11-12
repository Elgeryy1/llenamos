import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ call: vi.fn(), live: vi.fn(), close: vi.fn(), firestore: vi.fn(), shown: [] as string[], subscribed: false }))
// Si el módulo se cargara alguna vez, este contador lo delataría.
vi.mock("firebase/firestore", () => { mocks.firestore(); return {} })
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: () => ({ role: "waiter", restaurant: { id: "r", plan: "sala" }, location: { id: "l" }, user: { uid: "u" } }) }))
vi.mock("@/lib/api/live", () => ({ useLiveQuery: mocks.live }))
vi.mock("@/lib/api/operations", async (original) => ({ ...(await original<typeof import("@/lib/api/operations")>()), invokeOperation: mocks.call }))

const tarea = (id: string, over: object = {}) => ({ id, status: "open", claimedBy: null, ...over })
const servicio = (tasks: object[]) => ({ status: "ready", data: { sessions: [], orders: [], lines: [], tasks, takeaways: [], truncated: false } })

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
  mocks.call.mockReset(); mocks.live.mockReset(); mocks.close.mockReset(); mocks.firestore.mockReset(); mocks.shown = []; mocks.subscribed = false
  mocks.call.mockImplementation(async () => ({ configured: true, publicKey: "AQAB", localCapture: false, subscribedEndpoints: mocks.subscribed ? ["https://fcm.googleapis.com/send/a"] : [] }))
  Object.defineProperty(navigator, "serviceWorker", { configurable: true, value: {
    register: vi.fn(),
    getRegistration: vi.fn().mockImplementation(async () => ({
      pushManager: { getSubscription: vi.fn().mockResolvedValue(mocks.subscribed ? { endpoint: "https://fcm.googleapis.com/send/a" } : null) },
      getNotifications: async (filter?: { tag: string }) => (filter ? [filter.tag] : mocks.shown).map(tag => ({ tag, close: () => mocks.close(tag) })),
    })),
  } })
})
afterEach(() => vi.unstubAllEnvs())

it("en el VPS se ofrece el aviso al móvil, porque el worker ya envía las tareas vencidas", async () => {
  mocks.live.mockReturnValue(servicio([]))
  const { AvisosMovil } = await import("./AvisosMovil")
  render(<AvisosMovil />)
  await screen.findByText(/Avisos al móvil/)
  expect(mocks.call).toHaveBeenCalledWith("configuracionPush", { restaurantId: "r", locationId: "l" })
})
it("sin avisos activados en este móvil no abre ningún flujo del servicio en vivo ni carga Firestore", async () => {
  mocks.live.mockReturnValue({ status: "loading" })
  const { AvisosMovil } = await import("./AvisosMovil")
  render(<AvisosMovil />)
  await screen.findByText(/Avisos al móvil/)
  await vi.waitFor(() => expect(mocks.call).toHaveBeenCalled())
  expect(mocks.live.mock.calls.every(([, input]) => input === null)).toBe(true)
  expect(mocks.firestore).not.toHaveBeenCalled()
})
it("con los avisos activados retira los de tareas ya cogidas al empezar y los de las que se cogen después", async () => {
  mocks.subscribed = true
  mocks.shown = ["task:r:l:t0", "task:r:l:t1", "task:otro:l:t9"]
  mocks.live.mockImplementation((_n: string, input: unknown) => input === null ? { status: "loading" } : servicio([tarea("t1"), tarea("t2")]))
  const { AvisosMovil } = await import("./AvisosMovil")
  const { rerender } = render(<AvisosMovil />)
  // Primera lectura: t0 ya no está sin dueño; t1 sigue, y los avisos de otro local no se tocan.
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith("task:r:l:t0"))
  expect(mocks.close).not.toHaveBeenCalledWith("task:r:l:t1"); expect(mocks.close).not.toHaveBeenCalledWith("task:otro:l:t9")
  mocks.live.mockImplementation((_n: string, input: unknown) => input === null ? { status: "loading" } : servicio([tarea("t1", { status: "claimed", claimedBy: "otro" })]))
  rerender(<AvisosMovil />)
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith("task:r:l:t1"))
  await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledWith("task:r:l:t2"))
  expect(mocks.firestore).not.toHaveBeenCalled()
})
