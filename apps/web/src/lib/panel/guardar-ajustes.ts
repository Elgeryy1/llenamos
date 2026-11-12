import { z } from "zod"
import { dataBackend } from "@/lib/api/config"
import { postOperation } from "@/lib/api/transport"
import { firebaseConfig } from "@/lib/firebase/config"
import type { Ajustes } from "./ajustes"
import { cargarClienteDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"

const Respuesta = z.object({ ok: z.literal(true) })

/**
 * Guarda nombre, color o idioma. En el VPS es una operación explícita de la API (rol, restaurante y
 * cambios los comprueba el servidor); la escritura directa a Firestore solo existe en la demo.
 */
export async function guardarAjustes(restaurantId: string, uid: string, changes: Partial<Ajustes>): Promise<void> {
  if (dataBackend(firebaseConfig.ok ? firebaseConfig.settings : null) === "postgres") {
    Respuesta.parse(await postOperation("guardarAjustesRestaurante", { restaurantId, ...changes }, { authentication: "required", timeoutMs: 20_000 }))
    return
  }
  const [{ doc, serverTimestamp, updateDoc }, { getFirebase }] = await Promise.all([cargarFirestore(), cargarClienteDemo()])
  await updateDoc(doc(getFirebase().db, "restaurants", restaurantId), { ...changes, updatedBy: uid, updatedAt: serverTimestamp() })
}
