/**
 * Guardar el borrador del plano en Firestore.
 *
 * Las reglas exigen en cada alta y cambio `updatedBy` (quien escribe), `updatedAt`
 * (la hora del servidor) y `createdAt` (en las altas, también la del servidor), y
 * comprueban que la zona de una mesa existe. En un lote, esa comprobación ve los
 * datos de antes del lote, así que se escribe en tres pasos:
 *   1. zonas nuevas y cambios de zonas,
 *   2. mesas (altas, cambios y bajas),
 *   3. bajas de zonas (ya sin mesas).
 * Cada paso es atómico. Si falla uno, los anteriores ya están guardados y se dice.
 */
import { MAX_WRITES, type PlanoChanges } from "./editor"
import { llamarCore } from "@/lib/data/callables"
import { cargarDemoEscrituras } from "@/lib/data/demo-carga"

export type WriteOp =
  | { kind: "create"; collection: "areas" | "tables"; id: string; data: Record<string, unknown> }
  | { kind: "update"; collection: "areas" | "tables"; id: string; data: Record<string, unknown> }
  | { kind: "delete"; collection: "areas" | "tables"; id: string }

export interface WriteStep {
  label: string
  ops: WriteOp[]
}

/** Pasos y escrituras de un guardado, sin tocar Firestore (se puede probar). */
export function planWriteSteps(c: PlanoChanges): WriteStep[] {
  const steps: WriteStep[] = [
    {
      label: "zonas",
      ops: [
        ...c.createAreas.map((a): WriteOp => ({ kind: "create", collection: "areas", id: a.id, data: { ...a.data } })),
        ...c.updateAreas.map((a): WriteOp => ({ kind: "update", collection: "areas", id: a.id, data: { ...a.data } })),
      ],
    },
    {
      label: "mesas",
      ops: [
        ...c.createTables.map((t): WriteOp => ({ kind: "create", collection: "tables", id: t.id, data: { ...t.data } })),
        ...c.updateTables.map((t): WriteOp => ({ kind: "update", collection: "tables", id: t.id, data: { ...t.data } })),
        ...c.deleteTables.map((id): WriteOp => ({ kind: "delete", collection: "tables", id })),
      ],
    },
    {
      label: "zonas borradas",
      ops: c.deleteAreas.map((id): WriteOp => ({ kind: "delete", collection: "areas", id })),
    },
  ]
  return steps.filter((s) => s.ops.length > 0)
}

export class PlanoSaveError extends Error {
  constructor(
    readonly step: string,
    readonly saved: string[],
    readonly cause: unknown,
  ) {
    super(
      saved.length > 0
        ? `Se han guardado las ${saved.join(" y las ")}, pero no las ${step}.`
        : `No se han podido guardar las ${step}.`,
    )
    this.name = "PlanoSaveError"
  }
}

/**
 * Solo demo: escribe los cambios del plano de `restaurants/{rid}/locations/{lid}` en los emuladores.
 * `uid` va en `updatedBy` de cada alta y cambio. El SDK de Firestore se carga con `cargarDemoEscrituras()`, nunca en el VPS.
 */
export async function savePlano(base: string, uid: string, changes: PlanoChanges): Promise<void> {
  const { escribirPasoPlano } = await cargarDemoEscrituras()
  const saved: string[] = []
  for (const step of planWriteSteps(changes)) {
    if (step.ops.length > MAX_WRITES) {
      throw new PlanoSaveError(step.label, saved, new Error(`Demasiados cambios a la vez (${step.ops.length}).`))
    }
    try {
      await escribirPasoPlano({ base, uid, ops: step.ops })
    } catch (error) {
      throw new PlanoSaveError(step.label, saved, error)
    }
    saved.push(step.label)
  }
}

/** Id nuevo para una zona o mesa: lo elige el navegador (también en la demo) y el servidor comprueba que no exista. */
export function newPlanoId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 20)
}

/**
 * Guarda el plano en el VPS con un solo comando: la API lo aplica en una transacción, así que
 * o entra todo o no entra nada (ya no hay tres lotes con guardados a medias).
 */
export async function savePlanoCommand(restaurantId: string, locationId: string, c: PlanoChanges): Promise<void> {
  const total = c.createAreas.length + c.updateAreas.length + c.deleteAreas.length + c.createTables.length + c.updateTables.length + c.deleteTables.length
  if (total > MAX_WRITES) throw new PlanoSaveError("cambios", [], new Error(`Demasiados cambios a la vez (${total}).`))
  try {
    await llamarCore("guardarPlano", {
      restaurantId,
      locationId,
      createAreas: c.createAreas.map((a) => ({ id: a.id, ...a.data })),
      updateAreas: c.updateAreas.map((a) => ({ id: a.id, ...a.data })),
      deleteAreas: c.deleteAreas,
      createTables: c.createTables.map((t) => ({ id: t.id, ...t.data })),
      updateTables: c.updateTables.map((t) => ({ id: t.id, ...t.data })),
      deleteTables: c.deleteTables,
    })
  } catch (error) {
    throw new PlanoSaveError("cambios", [], error)
  }
}
