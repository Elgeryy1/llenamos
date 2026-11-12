import type { CallableInput, CallableWithSchema } from "@llenamos/core"
import { dataBackend } from "./config"
import { postOperation, type OperationOptions } from "./transport"
import { firebaseConfig } from "@/lib/firebase/config"
import { cargarClienteDemo, cargarFunctions } from "@/lib/firebase/cargar-demo"

export function operationBackend(): "postgres" | "firebase-demo" {
  return dataBackend(firebaseConfig.ok ? firebaseConfig.settings : null)
}

/** Entrada/salida se validan en el wrapper del módulo. No cambia de backend por un fallo. */
export async function invokeOperation(name: CallableWithSchema, data: unknown, options: Partial<OperationOptions> = {}): Promise<unknown> {
  const authentication = options.authentication ?? "required"
  if (operationBackend() === "postgres") return postOperation(name, data, { ...options, authentication })
  if (authentication === "none") {
    // Única operación pública adicional de estos módulos. No carga identidad ni SDK de Functions.
    if (name !== "darseDeBaja") throw new Error("La operación pública no pertenece a este transporte de demostración.")
    const { callPublic } = await import("@/lib/publica/callables")
    return callPublic(firebaseConfig.ok ? firebaseConfig.settings : null, name, data as CallableInput<"darseDeBaja">, options)
  }
  const [{ httpsCallable }, { getFirebase }] = await Promise.all([cargarFunctions(), cargarClienteDemo()])
  return (await httpsCallable<unknown, unknown>(getFirebase().functions, name, { timeout: options.timeoutMs ?? 20_000 })(data)).data
}

/** Los errores VPS tienen código sin prefijo; los emuladores mantienen functions/. */
export function operationErrorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code).replace(/^functions\//, "") : ""
}
export const DEFINITIVE_OPERATION_ERRORS = ["invalid-argument", "permission-denied", "unauthenticated", "failed-precondition", "already-exists", "not-found", "not-deployed", "resource-exhausted"] as const
export function isDefinitiveOperationError(error: unknown): boolean {
  return (DEFINITIVE_OPERATION_ERRORS as readonly string[]).includes(operationErrorCode(error))
}
