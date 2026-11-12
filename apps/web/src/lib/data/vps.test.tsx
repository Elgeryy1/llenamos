import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const llamarCore = vi.fn()
const apiLive = vi.fn()
vi.mock("./callables", () => ({ llamarCore: (...args: unknown[]) => llamarCore(...args) }))
vi.mock("@/lib/api/live", () => ({ useLiveQuery: (...args: unknown[]) => apiLive(...args) }))
vi.mock("@/lib/firebase/live", () => ({ useLiveDoc: () => ({ status: "loading" }), useLiveQuery: () => ({ status: "loading" }) }))
vi.mock("@/lib/firebase/client", () => ({ getFirebase: () => { throw new Error("En el VPS no se debe tocar Firebase.") } }))

import { diffDraft, addTable, type PlanoDraft } from "@/lib/plano/editor"
import { savePlanoCommand } from "@/lib/plano/guardar"
import { saveCustomerEdit } from "./clientes"
import { useDayReservations, useReservationSettings } from "./reservas"
import { activityAvailable } from "./backend"
import { useActivity, useMembers, useSala } from "./hooks"
import { defaultReservationSettings, settingsToConfiguracion } from "@llenamos/core"

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); llamarCore.mockReset(); apiLive.mockReset(); apiLive.mockReturnValue({ status: "loading" }) })
afterEach(() => vi.unstubAllEnvs())

const base: PlanoDraft = { areas: [{ id: "sala", name: "Sala", sortOrder: 0 }], tables: [] }

describe("reservas en el VPS sin Firebase", () => {
  it("el plano se guarda con un solo comando explícito, sin UID del navegador", async () => {
    const draft = addTable(base, "sala", "t1")
    await savePlanoCommand("r1", "centro", diffDraft(base, draft))
    expect(llamarCore).toHaveBeenCalledTimes(1)
    const [name, input] = llamarCore.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe("guardarPlano")
    expect(input).toMatchObject({ restaurantId: "r1", locationId: "centro", createTables: [expect.objectContaining({ id: "t1", areaId: "sala" })], deleteTables: [] })
    expect(JSON.stringify(input)).not.toMatch(/updatedBy|uid/i)
  })

  it("un fallo del comando se muestra como guardado fallido y no se reintenta", async () => {
    llamarCore.mockRejectedValueOnce(new Error("sin permiso"))
    await expect(savePlanoCommand("r1", "centro", diffDraft(base, addTable(base, "sala", "t1")))).rejects.toMatchObject({ name: "PlanoSaveError" })
    expect(llamarCore).toHaveBeenCalledTimes(1)
  })

  it("la ficha de cliente se edita por comando y sin Firestore", async () => {
    await saveCustomerEdit("r1", "a".repeat(20), { notes: "n", allergies: "", tags: ["vip"] }, "uid-del-navegador")
    expect(llamarCore).toHaveBeenCalledWith("editarCliente", { restaurantId: "r1", customerId: "a".repeat(20), notes: "n", allergies: "", tags: ["vip"] })
  })

  it("las lecturas piden las consultas del servidor y no escuchan Firestore", () => {
    const settings = defaultReservationSettings("Europe/Madrid")
    apiLive.mockImplementation((name: string) => name === "ajustesReservas" ? { status: "ready", data: { settings, saved: true } } : { status: "loading" })
    const { result } = renderHook(() => useReservationSettings("r1", "centro", "Europe/Madrid"))
    expect(result.current).toEqual({ status: "ready", data: { settings, config: settingsToConfiguracion(settings), saved: true } })
    expect(apiLive).toHaveBeenCalledWith("ajustesReservas", { restaurantId: "r1", locationId: "centro" }, expect.anything())

    renderHook(() => useDayReservations("r1", "centro", "2026-12-02", settingsToConfiguracion(settings)))
    expect(apiLive).toHaveBeenCalledWith("reservasDia", { restaurantId: "r1", locationId: "centro", date: "2026-12-02" }, expect.anything())
    renderHook(() => useSala("r1", "centro"))
    expect(apiLive).toHaveBeenCalledWith("plano", { restaurantId: "r1", locationId: "centro" }, expect.anything())
  })

  it("mientras la lectura en vivo no esté desplegada, el error llega a la interfaz", () => {
    apiLive.mockReturnValue({ status: "error", error: new Error("no desplegado") })
    const { result } = renderHook(() => useSala("r1", "centro"))
    expect(result.current.status).toBe("error")
  })

  it("el equipo sale de la lectura miembros; la actividad no existe en SQL y las pantallas la ocultan", () => {
    renderHook(() => useMembers("r1"))
    expect(apiLive).toHaveBeenCalledWith("miembros", { restaurantId: "r1" }, expect.anything())
    const off = renderHook(() => useMembers("r1", false))
    expect(off.result.current).toEqual({ status: "loading" })
    const activity = renderHook(() => useActivity("r1", 6))
    expect(activity.result.current).toMatchObject({ status: "error", error: { code: "not-deployed" } })
    expect(apiLive).not.toHaveBeenCalledWith("actividad", expect.anything(), expect.anything())
    expect(activityAvailable()).toBe(false)
  })
})
