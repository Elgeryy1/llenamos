import { describe, expect, it } from "vitest"
import { ZodError } from "zod"
import { validarEntrada } from "./functions"

describe("validarEntrada", () => {
  it("limpia el correo de una invitación", () => {
    expect(
      validarEntrada("invitarMiembro", {
        restaurantId: "demo-lumbre",
        email: "  Pau@Lumbre.TEST ",
        displayName: " Pau Soler ",
        role: "waiter",
      }),
    ).toEqual({ restaurantId: "demo-lumbre", email: "pau@lumbre.test", displayName: "Pau Soler", role: "waiter" })
  })

  it("no llama al servidor con datos que va a rechazar", () => {
    const bad = { restaurantId: "r", email: "no-es-correo", displayName: "", role: "waiter" as const }
    try {
      validarEntrada("invitarMiembro", bad)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ZodError)
      const paths = (e as ZodError).issues.map((i) => i.path[0])
      expect(paths).toEqual(expect.arrayContaining(["email", "displayName"]))
    }
  })

  it("solo acepta roles del contrato", () => {
    expect(() =>
      // @ts-expect-error: «jefe» no es un rol
      validarEntrada("cambiarRolMiembro", { restaurantId: "r", uid: "u", role: "jefe" }),
    ).toThrow(ZodError)
  })
  it("rechaza contraseñas fijadas por quien invita", () => {
    expect(() => validarEntrada("invitarMiembro", { restaurantId: "r", email: "persona@example.test", displayName: "Persona", role: "waiter", password: "conocida-por-invitador" } as never)).toThrow(ZodError)
  })

  it("pide nombre de restaurante y de local", () => {
    expect(() => validarEntrada("crearRestaurante", { name: "A", locationName: "Centro" })).toThrow(ZodError)
    expect(validarEntrada("crearRestaurante", { name: " Taberna ", locationName: "Centro" })).toEqual({
      name: "Taberna",
      locationName: "Centro",
    })
  })
})
