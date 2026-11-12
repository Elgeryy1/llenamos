/**
 * Convierte cualquier error (de Firebase, de validación o desconocido) en un
 * mensaje en castellano que se pueda enseñar a quien usa el panel.
 */
import { FirebaseError } from "firebase/app"
import { ZodError } from "zod"
import { FirebaseConfigError } from "./config-error"
import { DataBackendConfigError } from "@/lib/api/config"
import { ApiCallError } from "@/lib/api/transport"

export interface ErrorInfo {
  message: string
  /** Código técnico para quien tenga que arreglarlo, si lo hay. */
  code?: string
}

const AUTH: Record<string, string> = {
  "auth/invalid-credential": "El correo o la contraseña no son correctos.",
  "auth/invalid-login-credentials": "El correo o la contraseña no son correctos.",
  "auth/wrong-password": "El correo o la contraseña no son correctos.",
  "auth/user-not-found": "El correo o la contraseña no son correctos.",
  "auth/invalid-email": "Ese correo no parece válido.",
  "auth/missing-password": "Escribe la contraseña.",
  "auth/user-disabled": "Esta cuenta está desactivada. Habla con quien gestiona tu restaurante.",
  "auth/too-many-requests": "Demasiados intentos seguidos. Espera un momento y vuelve a probar.",
  "auth/network-request-failed":
    "No hay conexión con el servicio de acceso. Si estás en local, comprueba que los emuladores están en marcha.",
}

const FIRESTORE: Record<string, string> = {
  "permission-denied": "No tienes permiso para ver o cambiar esto.",
  unavailable: "No hay conexión con la base de datos. Si estás en local, comprueba que los emuladores están en marcha.",
  "not-found": "Esto ya no existe.",
  unauthenticated: "Tu sesión ha caducado. Vuelve a entrar.",
  "failed-precondition": "La base de datos necesita un índice o una condición que no se cumple.",
  "resource-exhausted": "Se ha superado un límite de uso. Prueba dentro de un rato.",
  "deadline-exceeded": "La base de datos ha tardado demasiado en responder.",
}

/** Mensajes genéricos de las funciones cuando el servidor no manda uno propio. */
const FUNCTIONS: Record<string, string> = {
  internal:
    "El servidor no ha respondido. Si estás en local, comprueba que el emulador de funciones está en marcha y que las funciones están compiladas.",
  unavailable: "El servidor de funciones no está disponible ahora mismo.",
  "not-found": "Esta función no existe en el servidor. Puede que aún no esté publicada o compilada.",
  "deadline-exceeded":
    "El servidor ha tardado demasiado en responder. Si estás en local, comprueba que el emulador de funciones está en marcha.",
  unauthenticated: "Tu sesión ha caducado. Vuelve a entrar.",
  "permission-denied": "No tienes permiso para hacer esto.",
  "invalid-argument": "Algún dato no es válido.",
  "already-exists": "Eso ya existe.",
  "failed-precondition": "No se puede hacer en este momento.",
  "resource-exhausted": "Se ha superado un límite de uso. Prueba dentro de un rato.",
  cancelled: "Se ha cancelado la operación.",
  unknown: "El servidor ha devuelto un error desconocido.",
}

const FALLBACK = "Algo ha fallado. Vuelve a intentarlo."

/**
 * El SDK pone como mensaje el propio código («internal», «NOT_FOUND») cuando el
 * servidor no manda texto. Ese mensaje no sirve para nadie.
 */
function isBareCode(message: string, code: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[\s_-]+/g, "")
  return norm(message) === norm(code) || message.trim() === ""
}

export function describeError(error: unknown): ErrorInfo {
  if (error instanceof ApiCallError) return { code: error.code, message: error.code === "internal" || error.code === "unknown" ? FALLBACK : error.message }
  if (error instanceof DataBackendConfigError) return { code: "config", message: error.message }
  if (error instanceof FirebaseConfigError) {
    return { message: error.problems.join(" "), code: "config" }
  }

  if (error instanceof ZodError) {
    const first = error.issues[0]
    return { message: first?.message ?? "Algún dato no es válido.", code: "validation" }
  }

  if (error instanceof FirebaseError) {
    const { code } = error

    if (code.startsWith("auth/")) {
      return { message: AUTH[code] ?? FALLBACK, code }
    }

    if (code.startsWith("functions/")) {
      const short = code.slice("functions/".length)
      // El servidor manda mensajes en castellano pensados para enseñarse (contrato).
      if (short !== "internal" && !isBareCode(error.message, short)) {
        return { message: error.message, code }
      }
      return { message: FUNCTIONS[short] ?? FALLBACK, code }
    }

    // Firestore usa códigos sin prefijo.
    return { message: FIRESTORE[code] ?? FALLBACK, code }
  }

  if (error instanceof Error && error.message) {
    return { message: error.message }
  }

  return { message: FALLBACK }
}

/** ¿Es un error de permisos? Sirve para enseñar «sin acceso» en vez de un fallo. */
export function isPermissionDenied(error: unknown): boolean {
  if (error instanceof ApiCallError) return error.code === "permission-denied"
  return error instanceof FirebaseError && (error.code === "permission-denied" || error.code === "functions/permission-denied")
}
