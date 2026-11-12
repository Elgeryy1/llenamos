import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, expect, it, vi } from "vitest"

const ejecutar = vi.fn()
const estado = vi.hoisted(() => ({ fichajes: { status: "ready", data: [] } as unknown }))

vi.mock("@/components/panel/PanelContext", () => ({
  usePanel: () => ({ user: { uid: "u1" }, location: { id: "centro", name: "Centro" } }),
}))
vi.mock("./piezas", async (original) => ({
  ...(await original<typeof import("./piezas")>()),
  PuertaPersonal: ({ children }: { children: (s: { restaurantId: string; locationId: string }) => React.ReactNode }) => children({ restaurantId: "demo", locationId: "centro" }),
}))
vi.mock("@/lib/personal/api", () => ({ useAccionPersonal: () => ({ ejecutar, ocupado: false }) }))
vi.mock("@/lib/personal/datos", () => ({
  useFichajesDe: () => estado.fichajes,
  useTurnosSemana: () => ({ status: "ready", data: [] }),
  useInformeHoras: () => ({ status: "ready", rows: [] }),
}))

import { Fichaje } from "./Fichaje"

const abierto = (extra: object = {}) => ({
  id: "e1", uid: "u1", date: "2026-11-10", startAt: Date.now() - 3_600_000, endAt: null, breaks: [], status: "open", startSource: "self", endSource: null,
  shiftId: null, forgotten: false, needsReview: false, workedMinutes: null, breakMinutes: 0, note: null, revision: 1, ...extra,
})

beforeEach(() => {
  ejecutar.mockReset()
  ejecutar.mockResolvedValue({ ok: true, data: { entryId: "e1", state: "working", at: Date.now(), workedMinutes: null } })
  estado.fichajes = { status: "ready", data: [] }
})

it("sin fichaje abierto solo ofrece fichar la entrada y manda la acción, sin hora", async () => {
  render(<Fichaje />)
  expect(screen.getByText("Aún no has fichado")).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Salir/ })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Fichar entrada/ }))
  await waitFor(() => expect(ejecutar).toHaveBeenCalledWith("fichar", { action: "in", note: null }))
  expect(await screen.findByText(/Entrada fichada a las/)).toBeTruthy()
})

it("trabajando ofrece pausa y salida, y la salida pide confirmación", async () => {
  estado.fichajes = { status: "ready", data: [abierto()] }
  render(<Fichaje />)
  expect(screen.getByText(/Trabajando desde/)).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: /Salir/ }))
  expect(ejecutar).not.toHaveBeenCalled()
  expect(screen.getByRole("group", { name: "Confirmar la salida" })).toBeTruthy()
  fireEvent.click(screen.getByRole("button", { name: "Seguir" }))
  expect(screen.queryByRole("group", { name: "Confirmar la salida" })).toBeNull()
  fireEvent.click(screen.getByRole("button", { name: /Salir/ }))
  fireEvent.click(screen.getByRole("button", { name: /Sí, salir/ }))
  await waitFor(() => expect(ejecutar).toHaveBeenCalledWith("fichar", { action: "out", note: null }))
})

it("en pausa ofrece volver, no empezar otra pausa", () => {
  estado.fichajes = { status: "ready", data: [abierto({ breaks: [{ startAt: Date.now() - 600_000, endAt: null }] })] }
  render(<Fichaje />)
  expect(screen.getByText("Estás en pausa")).toBeTruthy()
  expect(screen.getByRole("button", { name: /Volver de la pausa/ })).toBeTruthy()
  expect(screen.queryByRole("button", { name: /^Pausa$/ })).toBeNull()
})

it("un fichaje olvidado no se puede cerrar fichando: avisa y no ofrece botones", () => {
  estado.fichajes = { status: "ready", data: [abierto({ forgotten: true, date: "2026-11-08" })] }
  render(<Fichaje />)
  expect(screen.getByText("Tu fichaje sigue abierto de otro día")).toBeTruthy()
  expect(screen.getByText(/No se puede fichar hasta que un encargado lo cierre/)).toBeTruthy()
  expect(screen.queryByRole("button", { name: /Fichar entrada|Salir|Pausa/ })).toBeNull()
})

it("si el servidor rechaza, enseña su mensaje y no dice que ha fichado", async () => {
  ejecutar.mockResolvedValue({ ok: false, message: "Ya tienes el fichaje abierto.", error: new Error("x") })
  render(<Fichaje />)
  fireEvent.click(screen.getByRole("button", { name: /Fichar entrada/ }))
  expect(await screen.findByText("Ya tienes el fichaje abierto.")).toBeTruthy()
  expect(screen.queryByText(/Entrada fichada/)).toBeNull()
})
