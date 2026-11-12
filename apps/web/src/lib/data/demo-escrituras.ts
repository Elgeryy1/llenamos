/** Escrituras directas de la demo con emuladores. Solo se carga con `cargarDemoEscrituras()`; el VPS usa operaciones de la API. */
import type { CustomerEditable } from "@llenamos/core"
import { doc, serverTimestamp, updateDoc, writeBatch } from "firebase/firestore"
import { getFirebase } from "@/lib/firebase/client"

export async function editarClienteDemo(restaurantId: string, customerId: string, value: CustomerEditable, uid: string): Promise<void> {
  const { db } = getFirebase()
  await updateDoc(doc(db, `restaurants/${restaurantId}/customers/${customerId}`), {
    notes: value.notes,
    allergies: value.allergies,
    tags: value.tags,
    updatedBy: uid,
    updatedAt: serverTimestamp(),
  })
}

export interface PasoPlano {
  base: string
  uid: string
  ops: ReadonlyArray<
    | { kind: "create" | "update"; collection: string; id: string; data: Record<string, unknown> }
    | { kind: "delete"; collection: string; id: string }
  >
}

/** Un lote atómico de escrituras del plano (las reglas exigen `updatedBy` y las horas del servidor). */
export async function escribirPasoPlano(step: PasoPlano): Promise<void> {
  const { db } = getFirebase()
  const batch = writeBatch(db)
  for (const op of step.ops) {
    const ref = doc(db, `${step.base}/${op.collection}/${op.id}`)
    if (op.kind === "create") batch.set(ref, { ...op.data, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), updatedBy: step.uid })
    else if (op.kind === "update") batch.update(ref, { ...op.data, updatedAt: serverTimestamp(), updatedBy: step.uid })
    else batch.delete(ref)
  }
  await batch.commit()
}
