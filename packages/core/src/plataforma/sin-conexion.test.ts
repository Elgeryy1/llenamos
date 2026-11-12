import { describe, expect, it } from "vitest"
import { applyCommandReceipt, canonicalJson, commandFingerprint, commandReceiptForWrite, CommandReceiptSchema, commandVersionConflicts, enqueueLocalCommand, nextLocalCommand, OfflineCashNoteSchema, OfflineCommandSchema, recoverCommand, retryLocalCommand, syncStreamKey } from "./sin-conexion"
import type { CommandReceipt, OfflineCommand } from "./sin-conexion"
const base = { actorUid: "camarero", restaurantId: "r", locationId: "l", deviceId: "dispositivo_00001", commandId: "comando_estable_01", sequence: 1, clientCreatedAt: 1000, preconditions: [{ kind: "item", id: "p", version: "rev1" }], operation: "marcarAgotado", payload: { restaurantId: "r", locationId: "l", itemId: "p", soldOut: true } }
const command = OfflineCommandSchema.parse(base)
const receipt = (cmd: OfflineCommand): CommandReceipt => ({ commandId: cmd.commandId, streamKey: syncStreamKey(cmd), sequence: cmd.sequence, fingerprint: commandFingerprint(cmd), recordedAt: 2000, result: { status: "applied", response: { ok: true, soldOut: true }, versions: [{ kind: "item", id: "p", version: "rev2" }] } })
describe("cola local y recuperación", () => {
  it("normaliza objetos y conserva orden de listas en la huella", () => {
    expect(canonicalJson({ b: 2, a: [1, 2] })).toBe(canonicalJson({ a: [1, 2], b: 2 }))
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]))
    for (const value of [undefined, NaN, new Date(), { a: undefined }]) expect(() => canonicalJson(value)).toThrow()
    expect(commandFingerprint(command)).toBe(commandFingerprint(OfflineCommandSchema.parse(JSON.parse(JSON.stringify(command)))))
  })
  it("aísla persona, restaurante, local y dispositivo", () => {
    const keys = [command, { ...command, actorUid: "otro" }, { ...command, restaurantId: "otro" }, { ...command, locationId: "otro" }, { ...command, deviceId: "dispositivo_00002" }].map(syncStreamKey)
    expect(new Set(keys).size).toBe(5)
    expect(OfflineCommandSchema.safeParse({ ...base, locationId: "otro" }).success).toBe(false)
  })
  it("una misma intención se encola una vez y no se puede sobrescribir ni reordenar", () => {
    const entries = enqueueLocalCommand([], command)
    expect(enqueueLocalCommand(entries, command)).toEqual(entries)
    expect(() => enqueueLocalCommand(entries, { ...command, clientCreatedAt: 2000 })).toThrow()
    expect(() => enqueueLocalCommand(entries, { ...command, commandId: "comando_estable_02" })).toThrow()
    expect(() => enqueueLocalCommand(entries, { ...command, commandId: "comando_estable_02", sequence: 3 })).toThrow()
  })
  it("una respuesta perdida se recupera con la misma clave y contenido", () => {
    const entries = enqueueLocalCommand([], command)
    const uncertain = retryLocalCommand({ ...entries[0]!, state: "sending" }, 3000, "Se perdió la respuesta")
    expect(uncertain.command).toEqual(command)
    expect(uncertain.nextAttemptAt).toBe(4000)
    expect(nextLocalCommand([uncertain], command, 3999)).toBeNull()
    expect(nextLocalCommand([uncertain], command, 4000)?.command).toEqual(command)
    expect(applyCommandReceipt(uncertain, receipt(command)).state).toBe("applied")
    expect(recoverCommand(command, receipt(command))?.status).toBe("applied")
    expect(recoverCommand({ ...command, clientCreatedAt: 999 }, receipt(command))?.status).toBe("rejected")
  })
  it("bloquea lo posterior ante conflicto, rechazo o envío en vuelo sin perder la incidencia", () => {
    let entries = enqueueLocalCommand([], command)
    entries = enqueueLocalCommand(entries, { ...command, sequence: 2, commandId: "comando_estable_02" })
    for (const state of ["sending", "conflict", "rejected"] as const) expect(nextLocalCommand([{ ...entries[0]!, state }, entries[1]!], command, 99999)).toBeNull()
    expect(nextLocalCommand([{ ...entries[0]!, state: "discarded" }, entries[1]!], command, 99999)?.command.sequence).toBe(2)
    expect(commandVersionConflicts(command, [{ kind: "item", id: "p", version: "rev2" }])).toEqual(command.preconditions)
    expect(commandVersionConflicts(command, command.preconditions)).toEqual([])
  })
  it("requiere revisiones para todas las líneas y no permite cobros ni facturas", () => {
    const lines = { ...base, operation: "cambiarEstadoLineas", payload: { restaurantId: "r", locationId: "l", lineIds: ["a", "b"], status: "ready" }, preconditions: [{ kind: "line", id: "a", version: "rev1" }] }
    expect(OfflineCommandSchema.safeParse(lines).success).toBe(false)
    expect(OfflineCommandSchema.safeParse({ ...lines, preconditions: [...lines.preconditions, { kind: "line", id: "b", version: "rev1" }] }).success).toBe(true)
    for (const operation of ["registrarCobro", "emitirFactura", "abrirMesa", "pedirDesdeMesa"]) expect(OfflineCommandSchema.safeParse({ ...base, operation }).success).toBe(false)
  })
  it("rechaza una respuesta aplicada sin la forma de su operación y adapta fechas", () => {
    const r = receipt(command)
    expect(CommandReceiptSchema.parse(commandReceiptForWrite(r, (ms) => new Date(ms)))).toEqual(r)
    expect(() => recoverCommand(command, { ...r, result: { status: "applied", response: {}, versions: [] } })).toThrow()
  })
  it("el efectivo local queda como anotación y exige entrega suficiente", () => {
    const note = { actorUid: "u", restaurantId: "r", locationId: "l", deviceId: "dispositivo_00001", noteId: "anotacion_local_01", billId: "b", partId: "p", expectedRevision: 1, amountCents: 100, tipCents: 20, tenderedCents: 120, clientCreatedAt: 1000, status: "pending_review", paymentId: null }
    expect(OfflineCashNoteSchema.parse(note).status).toBe("pending_review")
    expect(OfflineCashNoteSchema.safeParse({ ...note, tenderedCents: 110 }).success).toBe(false)
  })
})

it("recarga envíos inciertos y encadena cambios sin reescribir las versiones del comando", async () => {
  const { recoverLocalQueueAfterReload, commandResultForResponse, inspectCommand } = await import("./sin-conexion")
  const entries = enqueueLocalCommand([], command)
  expect(recoverLocalQueueAfterReload([{ ...entries[0]!, state: "sending" }])[0]?.state).toBe("uncertain")
  expect(commandResultForResponse(command, { ok: true, soldOut: true }, [{ kind: "item", id: "p", version: "rev2" }]).status).toBe("applied")
  const next = OfflineCommandSchema.parse({ ...command, commandId: "comando_estable_02", sequence: 2, preconditions: [{ kind: "item", id: "p", version: "rev1", afterCommandId: command.commandId }] })
  const confirmed = receipt(command)
  const current = [{ kind: "item" as const, id: "p", version: "rev2" }]
  expect(inspectCommand(next, 1, null, current, 1001, 10000, [confirmed])).toEqual({ action: "execute" })
  expect(inspectCommand(next, 1, null, [{ ...current[0]!, version: "rev3" }], 1001, 10000, [confirmed])).toEqual({ action: "conflict", code: "stale_version" })
  expect(inspectCommand(next, 1, null, current, 1001, 10000, [{ ...confirmed, streamKey: "0".repeat(64) }])).toEqual({ action: "conflict", code: "stale_version" })
  expect(next.preconditions[0]?.version).toBe("rev1")
})

it("un rechazo de precio y una tarea cogida se conservan como conflictos, nunca como éxito", async () => {
  const { commandResultForResponse } = await import("./sin-conexion")
  const pedido = OfflineCommandSchema.parse({ ...base, operation: "enviarPedido", preconditions: [{ kind: "session", id: "s", version: "1" }], payload: { restaurantId: "r", locationId: "l", sessionId: "s", requestId: base.commandId, expectedDestination: "destino", expectedPrices: "precios", expectedTotalCents: 100, lines: [{ kind: "item", itemId: "p", quantity: 1 }] } })
  expect(OfflineCommandSchema.safeParse({ ...pedido, payload: { ...pedido.payload, requestId: "otro_identificador" } }).success).toBe(false)
  expect(OfflineCommandSchema.safeParse({ ...pedido, payload: { ...pedido.payload, expectedPrices: undefined } }).success).toBe(false)
  expect(commandResultForResponse(pedido, { status: "rejected", problems: [{ line: 0, selection: null, code: "price_changed", ref: "p" }], totalCents: 120 }, [])).toMatchObject({ status: "conflict", code: "price_changed" })
  expect(commandResultForResponse(pedido, { status: "rejected", problems: [{ line: 0, selection: null, code: "item_sold_out", ref: "p" }], totalCents: 0 }, [])).toMatchObject({ status: "conflict", code: "unavailable" })
  const tarea = OfflineCommandSchema.parse({ ...base, operation: "cambiarEstadoTarea", preconditions: [{ kind: "task", id: "t", version: "1" }], payload: { restaurantId: "r", locationId: "l", taskId: "t", action: "claim" } })
  expect(commandResultForResponse(tarea, { result: "taken", claimedBy: "lucia", claimedByName: "Lucía" }, [])).toMatchObject({ status: "conflict", code: "task_taken" })
})
