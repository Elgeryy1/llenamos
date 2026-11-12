import { describe, expect, it } from "vitest"
import { z } from "zod"
import { PublicCallError } from "./callables"
import { describePublicError, isSlotGone } from "./errores"
import { translator } from "./i18n"

const es = translator("es")
const en = translator("en")

describe("describePublicError", () => {
  it("traduce los mensajes conocidos del servidor", () => {
    const e = new PublicCallError("failed-precondition", "Esa franja ya no está disponible.")
    expect(describePublicError(e, "en", en).message).toBe("That time has just been taken. Please choose another one.")
    expect(isSlotGone(describePublicError(e, "es", es))).toBe(true)
    expect(describePublicError(new PublicCallError("failed-precondition", "El local no acepta reservas por la web."), "ca", translator("ca")).key).toBe("errBookingOff")
    expect(describePublicError(new PublicCallError("failed-precondition", "La oferta ha caducado o el enlace no es válido."), "es", es).key).toBe("errOfferExpired")
  })

  it("en castellano enseña tal cual un mensaje desconocido del servidor", () => {
    const e = new PublicCallError("failed-precondition", "Esta reserva ya no admite el pago de la señal.")
    expect(describePublicError(e, "es", es).message).toBe("Esta reserva ya no admite el pago de la señal.")
    expect(describePublicError(e, "en", en).message).toBe(en("errGeneric"))
  })

  it("usa el mensaje del código para la red, el límite de intentos y lo interno", () => {
    expect(describePublicError(new PublicCallError("network", "x"), "es", es).message).toBe(es("errNetwork"))
    expect(describePublicError(new PublicCallError("resource-exhausted", "Demasiadas solicitudes"), "en", en).key).toBe("errTooMany")
    expect(describePublicError(new PublicCallError("internal", "No se ha podido completar la operación."), "es", es).key).toBe("errGeneric")
    expect(describePublicError(new PublicCallError("not-deployed", "La función x no existe"), "es", es).key).toBe("errNotDeployed")
  })

  it("reconoce errores de validación y cualquier otra cosa", () => {
    const zod = z.string().safeParse(1).error
    expect(describePublicError(zod, "es", es).key).toBe("errInvalidData")
    expect(describePublicError(new Error("x"), "es", es).key).toBe("errGeneric")
  })
})
