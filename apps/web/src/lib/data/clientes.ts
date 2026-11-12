/**
 * Cambios de la ficha de cliente desde el navegador. Las reglas solo dejan tocar
 * `notes`, `allergies` y `tags`, con `updatedBy` (quien edita) y `updatedAt` del servidor.
 */
import { CustomerEditableSchema, type CustomerEditable } from "@llenamos/core"
import { llamarCore } from "./callables"
import { isVpsBackend } from "./backend"
import { cargarDemoEscrituras } from "./demo-carga"

/** «habitual, sin gluten,  terraza» → ["habitual", "sin gluten", "terraza"], sin repetir. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of text.split(/[,\n]/)) {
    const tag = raw.trim().replace(/\s+/g, " ")
    const key = tag.toLowerCase()
    if (tag === "" || seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

/** Valida lo editable; devuelve los datos limpios o el primer error de cada campo. */
export function validateCustomerEdit(input: { notes: string; allergies: string; tags: string }):
  | { ok: true; value: CustomerEditable }
  | { ok: false; errors: Partial<Record<keyof CustomerEditable, string>> } {
  const parsed = CustomerEditableSchema.safeParse({ notes: input.notes.trim(), allergies: input.allergies.trim(), tags: parseTags(input.tags) })
  if (parsed.success) return { ok: true, value: parsed.data }
  const errors: Partial<Record<keyof CustomerEditable, string>> = {}
  for (const issue of parsed.error.issues) {
    const key = issue.path[0]
    if ((key === "notes" || key === "allergies" || key === "tags") && !errors[key]) {
      errors[key] = key === "tags" && issue.path.length > 1 ? "Cada etiqueta, como mucho 30 caracteres." : issue.message
    }
  }
  return { ok: false, errors }
}

export async function saveCustomerEdit(restaurantId: string, customerId: string, value: CustomerEditable, uid: string): Promise<void> {
  // En el VPS es un comando de la API: el UID sale del token, nunca del navegador.
  if (isVpsBackend()) {
    await llamarCore("editarCliente", { restaurantId, customerId, ...value })
    return
  }
  const { editarClienteDemo } = await cargarDemoEscrituras()
  await editarClienteDemo(restaurantId, customerId, value, uid)
}
