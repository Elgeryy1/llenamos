/**
 * Llamadas a las funciones del servidor (callables, región europe-west1) tal y
 * como las define el contrato de ARQUITECTURA.md. La entrada se valida aquí con
 * zod antes de llamar; el servidor la vuelve a validar.
 */
import { RoleSchema } from "@llenamos/core"
import { z } from "zod"
import { dataBackend } from "@/lib/api/config"
import { postOperation } from "@/lib/api/transport"
import { firebaseConfig } from "@/lib/firebase/config"
import { cargarClienteDemo, cargarFunctions } from "@/lib/firebase/cargar-demo"

const nombre = z.string().trim().min(2, "Escribe al menos 2 letras.").max(80, "Como mucho 80 letras.")

export const CrearRestauranteInput = z.object({
  name: nombre,
  locationName: nombre,
})

export const InvitarMiembroInput = z.object({
  restaurantId: z.string().min(1),
  email: z.string().trim().toLowerCase().pipe(z.email("Ese correo no parece válido.")),
  displayName: z.string().trim().min(1, "Escribe el nombre.").max(80, "Como mucho 80 letras."),
  role: RoleSchema,
}).strict()

export const AceptarInvitacionInput = z.object({
  invitationId: z.string().regex(/^[a-f0-9]{64}$/),
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(12, "La contraseña debe tener al menos 12 caracteres.").max(128),
}).strict()

export const CambiarRolMiembroInput = z.object({
  restaurantId: z.string().min(1),
  uid: z.string().min(1),
  role: RoleSchema,
})

export const DesactivarMiembroInput = z.object({
  restaurantId: z.string().min(1),
  uid: z.string().min(1),
})

/** Entrada y salida de cada función. */
export interface ContratoFunciones {
  crearRestaurante: { input: z.input<typeof CrearRestauranteInput>; output: { restaurantId: string; locationId: string } }
  invitarMiembro: { input: z.input<typeof InvitarMiembroInput>; output: { uid: string; invitationStatus: "sent" | "pending" } }
  aceptarInvitacion: { input: z.input<typeof AceptarInvitacionInput>; output: { ok: true; email: string } }
  cambiarRolMiembro: { input: z.input<typeof CambiarRolMiembroInput>; output: { ok: true } }
  desactivarMiembro: { input: z.input<typeof DesactivarMiembroInput>; output: { ok: true } }
}

export type NombreFuncion = keyof ContratoFunciones

const TIMEOUT_MS = 20_000

const SCHEMAS: { [K in NombreFuncion]: z.ZodType<ContratoFunciones[K]["input"]> } = {
  crearRestaurante: CrearRestauranteInput,
  invitarMiembro: InvitarMiembroInput,
  aceptarInvitacion: AceptarInvitacionInput,
  cambiarRolMiembro: CambiarRolMiembroInput,
  desactivarMiembro: DesactivarMiembroInput,
}

const OUTPUTS: { [K in NombreFuncion]: z.ZodType<ContratoFunciones[K]["output"]> } = {
  crearRestaurante: z.object({ restaurantId: z.string().min(1), locationId: z.string().min(1) }),
  invitarMiembro: z.object({ uid: z.string().min(1), invitationStatus: z.enum(["sent", "pending"]) }),
  aceptarInvitacion: z.object({ ok: z.literal(true), email: z.email() }),
  cambiarRolMiembro: z.object({ ok: z.literal(true) }),
  desactivarMiembro: z.object({ ok: z.literal(true) }),
}

/** Valida la entrada sin llamar a nada. Lanza ZodError si no es válida. */
export function validarEntrada<K extends NombreFuncion>(name: K, input: ContratoFunciones[K]["input"]) {
  return SCHEMAS[name].parse(input)
}

export async function llamarFuncion<K extends NombreFuncion>(
  name: K,
  input: ContratoFunciones[K]["input"],
): Promise<ContratoFunciones[K]["output"]> {
  const data = validarEntrada(name, input)
  const backend = dataBackend(firebaseConfig.ok ? firebaseConfig.settings : null)
  let result: unknown
  if (backend === "postgres") {
    result = await postOperation(name, data, { authentication: name === "aceptarInvitacion" ? "none" : "required", timeoutMs: TIMEOUT_MS })
  } else {
    const [{ httpsCallable }, { getFirebase }] = await Promise.all([cargarFunctions(), cargarClienteDemo()])
    const callable = httpsCallable<unknown, unknown>(getFirebase().functions, name, { timeout: TIMEOUT_MS })
    result = (await callable(data)).data
  }
  return OUTPUTS[name].parse(result)
}
