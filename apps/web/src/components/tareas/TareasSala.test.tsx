vi.mock("@/components/sin-conexion/ColaServicio", () => ({ ColaServicio: () => null }))
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { FloorTaskWithId } from "@llenamos/core"
import { describe, expect, it, vi } from "vitest"
const { call } = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ user: { uid: "diego" }, role: "waiter" }),
}))
vi.mock("@/lib/comandero/callables", () => ({
  llamarSala: call,
  errorSala: (e: Error) => e.message,
}))
vi.mock("@/lib/comandero/datos", () => ({
  useServicio: () => ({ status: "ready", data: [] }),
  useTareas: () => ({ status: "ready", data: [task] }),
}))
import { TareasSala, TareaFila } from "./TareasSala"

// Tarea ficticia solo para pruebas de dueño y concurrencia.
const task: FloorTaskWithId = {
  id: "t1",
  type: "call_waiter",
  status: "open",
  sessionId: "s1",
  takeawayId: null,
  tableIds: ["sala-1"],
  label: "S1",
  orderId: null,
  stationId: null,
  lineIds: [],
  note: "Agua",
  dedupeKey: null,
  count: 1,
  openedAt: 100,
  dueAt: 200,
  createdBy: null,
  claimedBy: null,
  claimedByName: null,
  claimedAt: null,
  doneAt: null,
  doneBy: null,
}

describe("tareas de sala", () => {
  it("muestra al dueño y solo deja soltar al dueño o a quien gestiona el local", () => {
    const claimed = {
      ...task,
      status: "claimed" as const,
      claimedBy: "lucia",
      claimedByName: "Lucía",
    }
    const props = {
      task: claimed,
      uid: "diego",
      privileged: false,
      now: 201,
      busy: false,
      onAction: vi.fn(),
    }
    const { rerender } = render(
      <ul>
        <TareaFila {...props} />
      </ul>,
    )
    expect(screen.getByText("Va Lucía")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Voy yo" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Soltar tarea" })).toBeNull()
    rerender(
      <ul>
        <TareaFila {...props} privileged />
      </ul>,
    )
    expect(screen.getByRole("button", { name: "Soltar tarea" })).toBeTruthy()
  })
  it("si dos personas llegan a la vez, enseña a quien ha confirmado el servidor", async () => {
    call.mockResolvedValueOnce({
      result: "taken",
      claimedBy: "lucia",
      claimedByName: "Lucía",
    })
    render(<TareasSala scope={{ restaurantId: "r", locationId: "l" }} />)
    fireEvent.click(screen.getByRole("button", { name: "Voy yo" }))
    await waitFor(() => expect(screen.getByText(/Ya va Lucía/)).toBeTruthy())
    expect(call).toHaveBeenCalledWith("cambiarEstadoTarea", {
      restaurantId: "r",
      locationId: "l",
      taskId: "t1",
      action: "claim",
    })
    expect(screen.queryByText("Vas tú")).toBeNull()
  })
})
