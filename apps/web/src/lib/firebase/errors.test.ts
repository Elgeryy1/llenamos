import { FirebaseError } from "firebase/app"
import { describe, expect, it } from "vitest"
import { z } from "zod"
import { FirebaseConfigError } from "./client"
import { describeError, isPermissionDenied } from "./errors"
import { ApiCallError } from "@/lib/api/transport"

describe("describeError", () => {
  it("clasifica errores del VPS sin inicializar el SDK de datos", () => {
    expect(describeError(new ApiCallError("permission-denied", "No tienes acceso."))).toEqual({ code: "permission-denied", message: "No tienes acceso." })
    expect(describeError(new ApiCallError("internal", "detalle secreto")).message).not.toContain("secreto")
    expect(isPermissionDenied(new ApiCallError("permission-denied", "No tienes acceso."))).toBe(true)
  })
  it("no revela si el fallo es el correo o la contraseña", () => {
    for (const code of ["auth/invalid-credential", "auth/wrong-password", "auth/user-not-found"]) {
      expect(describeError(new FirebaseError(code, "x")).message).toBe("El correo o la contraseña no son correctos.")
    }
  })

  it("explica que faltan los emuladores cuando no hay red", () => {
    expect(describeError(new FirebaseError("auth/network-request-failed", "x")).message).toContain("emuladores")
  })

  it("enseña el mensaje en castellano que manda una función", () => {
    const e = new FirebaseError("functions/failed-precondition", "El restaurante no puede quedarse sin propietario.")
    expect(describeError(e)).toEqual({
      message: "El restaurante no puede quedarse sin propietario.",
      code: "functions/failed-precondition",
    })
  })

  it("cambia los mensajes que son solo el código por uno útil", () => {
    expect(describeError(new FirebaseError("functions/internal", "internal")).message).toContain("emulador de funciones")
    expect(describeError(new FirebaseError("functions/not-found", "NOT_FOUND")).message).toContain("no existe")
  })

  it("nunca enseña el mensaje de un error interno", () => {
    const e = new FirebaseError("functions/internal", "TypeError: cannot read x of undefined")
    expect(describeError(e).message).not.toContain("TypeError")
  })

  it("traduce los errores de Firestore", () => {
    expect(describeError(new FirebaseError("permission-denied", "Missing or insufficient permissions.")).message).toBe(
      "No tienes permiso para ver o cambiar esto.",
    )
  })

  it("usa el primer mensaje de una validación", () => {
    const r = z.object({ a: z.string().min(3, "Muy corto.") }).safeParse({ a: "x" })
    expect(r.success).toBe(false)
    if (!r.success) expect(describeError(r.error).message).toBe("Muy corto.")
  })

  it("lista los problemas de configuración", () => {
    expect(describeError(new FirebaseConfigError(["Falta A.", "Falta B."])).message).toBe("Falta A. Falta B.")
  })

  it("tiene un mensaje de reserva para lo desconocido", () => {
    expect(describeError("algo raro").message).toBe("Algo ha fallado. Vuelve a intentarlo.")
  })
})

describe("isPermissionDenied", () => {
  it("reconoce los dos sabores de permiso denegado", () => {
    expect(isPermissionDenied(new FirebaseError("permission-denied", ""))).toBe(true)
    expect(isPermissionDenied(new FirebaseError("functions/permission-denied", ""))).toBe(true)
    expect(isPermissionDenied(new FirebaseError("unavailable", ""))).toBe(false)
    expect(isPermissionDenied(new Error("permission-denied"))).toBe(false)
  })
})
