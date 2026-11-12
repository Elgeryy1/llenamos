import { describe, expect, it } from "vitest"
import {
  CALLABLE_REGION,
  CALLABLE_SCHEMAS,
  CALLABLES,
  CambiarEstadoReservaInputSchema,
  CambiarPlanInputSchema,
  ConsultarDisponibilidadInputSchema,
  CrearReservaInputSchema,
  CrearReservaPublicaInputSchema,
  CrearReservaPublicaOutputSchema,
  defaultReservationSettings,
  GestionarReservaPublicaInputSchema,
  GuardarConfiguracionReservasInputSchema,
  IMPORT_MAX_ROWS,
  ImportarReservasInputSchema,
  IniciarPagoSenalOutputSchema,
  linkToken,
  parseImportRow,
  ProcesarMensajesPendientesInputSchema,
  ProponerMesasReservaInputSchema,
  AsignarMesasInputSchema,
  type CallableInput,
} from "./index"

const publica: CallableInput<"crearReservaPublica"> = {
  slug: "demo-lumbre",
  locationId: "centro",
  date: "2026-11-10",
  time: "21:00",
  partySize: 4,
  guestName: "  Ana Puig ",
  phone: "612 34 56 78",
  email: "",
  language: "es",
  acceptPolicy: true,
  website: "",
}

const errores = (r: { success: boolean; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => `${i.path.join(".")}: ${i.message}`)

describe("nombres de las callables", () => {
  it("cada nombre es igual a su clave y todas las de la fase 1 tienen esquemas", () => {
    for (const [clave, nombre] of Object.entries(CALLABLES)) expect(nombre).toBe(clave)
    const fase0 = ["crearRestaurante", "invitarMiembro", "aceptarInvitacion", "cambiarRolMiembro", "desactivarMiembro"]
    expect(Object.keys(CALLABLES).filter((n) => !fase0.includes(n)).sort()).toEqual(Object.keys(CALLABLE_SCHEMAS).sort())
    expect(CALLABLE_REGION).toBe("europe-west1")
  })

  it("todas las entradas son estrictas: un campo de más es un error", () => {
    for (const [nombre, { input }] of Object.entries(CALLABLE_SCHEMAS)) {
      const r = input.safeParse({ campoInventado: 1 })
      expect(r.success, nombre).toBe(false)
      expect(errores(r).some((e) => e.includes("campoInventado")), nombre).toBe(true)
    }
  })
})

describe("reserva pública", () => {
  it("normaliza nombre, teléfono y correo vacío, y pone los valores por defecto", () => {
    expect(CrearReservaPublicaInputSchema.parse(publica)).toEqual({
      ...publica,
      guestName: "Ana Puig",
      phone: "+34612345678",
      email: null,
      guestNotes: "",
      source: "web",
      website: "",
    })
    expect(CrearReservaPublicaInputSchema.parse({ ...publica, email: " Ana@Ejemplo.COM " }).email).toBe("ana@ejemplo.com")
    expect(CrearReservaPublicaInputSchema.parse({ ...publica, email: undefined }).email).toBeNull()
  })

  it("el campo trampa tiene que ir vacío", () => {
    expect(errores(CrearReservaPublicaInputSchema.safeParse({ ...publica, website: "http://spam" }))).toEqual(["website: Solicitud no válida."])
    const { website: _trampa, ...sinTrampa } = publica
    expect(CrearReservaPublicaInputSchema.safeParse(sinTrampa).success).toBe(true)
  })

  it("explica lo que no vale", () => {
    expect(
      errores(
        CrearReservaPublicaInputSchema.safeParse({
          ...publica,
          date: "10/11/2026",
          time: "9:00",
          partySize: 0,
          guestName: " ",
          phone: "123",
          email: "ana@",
          acceptPolicy: false,
          guestNotes: "x".repeat(501),
        }),
      ),
    ).toEqual([
      // FechaSchema (del motor) avisa del formato y de que la fecha no existe.
      "date: Usa una fecha como 2026-11-09.",
      "date: Esa fecha no existe.",
      "time: Usa una hora como 13:30.",
      "partySize: Al menos 1 comensal.",
      "guestName: Escribe el nombre.",
      "phone: Un teléfono de España tiene 9 cifras y empieza por 6, 7, 8 o 9. Si es de otro país, empieza por + y su prefijo.",
      "email: Ese correo no parece válido.",
      "guestNotes: Como mucho 500 caracteres.",
      "acceptPolicy: Tienes que aceptar la política de reservas.",
    ])
    expect(CrearReservaPublicaInputSchema.safeParse({ ...publica, partySize: 201 }).success).toBe(false)
    expect(CrearReservaPublicaInputSchema.safeParse({ ...publica, partySize: 2.5 }).success).toBe(false)
    expect(CrearReservaPublicaInputSchema.safeParse({ ...publica, slug: "Demo Lumbre" }).success).toBe(false)
    expect(CrearReservaPublicaInputSchema.safeParse({ ...publica, date: "2026-02-30" }).success).toBe(false)
  })

  it("la salida lleva referencia, estado, token y señal", () => {
    const salida = {
      reference: "K7M2QX",
      status: "pending",
      manageToken: linkToken(new Uint8Array(32)),
      startAt: Date.UTC(2026, 10, 10, 20),
      deposit: { status: "not_configured", amountCents: 6000 },
    }
    expect(CrearReservaPublicaOutputSchema.parse(salida)).toEqual(salida)
    expect(CrearReservaPublicaOutputSchema.safeParse({ ...salida, reference: "k7m2qx" }).success).toBe(false)
  })

  it("gestionar normaliza la referencia y solo admite confirmar o cancelar", () => {
    const base = { slug: "demo-lumbre", reference: "k7m-2qx", token: linkToken(new Uint8Array(32)), action: "cancel" as const }
    expect(GestionarReservaPublicaInputSchema.parse(base)).toMatchObject({ reference: "K7M2QX", website: "" })
    expect(GestionarReservaPublicaInputSchema.safeParse({ ...base, action: "move" }).success).toBe(false)
    expect(GestionarReservaPublicaInputSchema.safeParse({ ...base, token: "corto" }).success).toBe(false)
  })

  it("consultar disponibilidad no pide datos personales", () => {
    expect(Object.keys(ConsultarDisponibilidadInputSchema.shape).sort()).toEqual(["date", "locationId", "partySize", "slug"])
  })
})

describe("callables del personal", () => {
  const ref = { restaurantId: "demo-lumbre", locationId: "centro" }

  it("crear reserva por teléfono o en el local", () => {
    const r = CrearReservaInputSchema.parse({ ...ref, date: "2026-11-10", time: "21:00", partySize: 2, guestName: "Ana", phone: "+34 612 345 678", source: "walk_in" })
    expect(r).toMatchObject({ status: "confirmed", language: "es", tableIds: [], skipWebLimits: true, email: null, notes: "" })
    expect(CrearReservaInputSchema.safeParse({ ...ref, date: "2026-11-10", time: "21:00", partySize: 2, guestName: "Ana", phone: "612345678", source: "web" }).success).toBe(false)
    expect(CrearReservaInputSchema.safeParse({ ...ref, date: "2026-11-10", time: "21:00", partySize: 2, guestName: "Ana", phone: "612345678", source: "phone", status: "finished" }).success).toBe(false)
  })

  it("mesas sin repetir y como mucho seis", () => {
    const base = { ...ref, reservationId: "r1" }
    expect(AsignarMesasInputSchema.parse({ ...base, tableIds: [] }).tableIds).toEqual([])
    expect(errores(AsignarMesasInputSchema.safeParse({ ...base, tableIds: ["S1", "S1"] }))).toEqual(["tableIds: Hay mesas repetidas."])
    expect(AsignarMesasInputSchema.safeParse({ ...base, tableIds: ["1", "2", "3", "4", "5", "6", "7"] }).success).toBe(false)
    expect(AsignarMesasInputSchema.safeParse({ ...base, tableIds: ["a/b"] }).success).toBe(false)
  })

  it("cambiar estado con o sin motivo", () => {
    const base = { ...ref, reservationId: "r1", status: "no_show" }
    expect(CambiarEstadoReservaInputSchema.safeParse(base).success).toBe(true)
    expect(CambiarEstadoReservaInputSchema.safeParse({ ...base, reason: null }).success).toBe(true)
    expect(CambiarEstadoReservaInputSchema.safeParse({ ...base, status: "no_presentada" }).success).toBe(false)
  })

  it("proponer mesas necesita una reserva o fecha, hora y comensales", () => {
    expect(ProponerMesasReservaInputSchema.parse({ ...ref, reservationId: "r1" }).limit).toBe(3)
    expect(ProponerMesasReservaInputSchema.safeParse({ ...ref, date: "2026-11-10", time: "21:00", partySize: 4 }).success).toBe(true)
    expect(errores(ProponerMesasReservaInputSchema.safeParse({ ...ref, date: "2026-11-10" }))).toEqual([
      "time: Sin reserva, hacen falta fecha, hora y comensales.",
      "partySize: Sin reserva, hacen falta fecha, hora y comensales.",
    ])
  })

  it("guardar configuración valida los ajustes completos", () => {
    const settings = defaultReservationSettings()
    expect(GuardarConfiguracionReservasInputSchema.safeParse({ ...ref, settings }).success).toBe(true)
    expect(GuardarConfiguracionReservasInputSchema.safeParse({ ...ref, settings: { ...settings, minPartySize: 20 } }).success).toBe(false)
  })

  it("cambiar plan con excepciones por módulo", () => {
    expect(CambiarPlanInputSchema.parse({ restaurantId: "demo-lumbre", plan: "sala" }).moduleOverrides).toEqual({})
    expect(CambiarPlanInputSchema.safeParse({ restaurantId: "demo-lumbre", plan: "sala", moduleOverrides: { repite: true } }).success).toBe(true)
    expect(CambiarPlanInputSchema.safeParse({ restaurantId: "demo-lumbre", plan: "oro" }).success).toBe(false)
  })

  it("procesar mensajes con límite razonable", () => {
    expect(ProcesarMensajesPendientesInputSchema.parse({})).toEqual({ limit: 100 })
    expect(ProcesarMensajesPendientesInputSchema.safeParse({ limit: 501 }).success).toBe(false)
  })

  it("pagar la señal devuelve una de cuatro respuestas", () => {
    expect(IniciarPagoSenalOutputSchema.parse({ status: "redirect", url: "https://checkout.stripe.com/c/pay/cs_test" }).status).toBe("redirect")
    expect(IniciarPagoSenalOutputSchema.safeParse({ status: "redirect", url: "http://malo" }).success).toBe(false)
    expect(IniciarPagoSenalOutputSchema.parse({ status: "not_configured", message: "Los pagos no están configurados." }).status).toBe("not_configured")
  })
})

describe("importar reservas", () => {
  const ref = { restaurantId: "demo-lumbre", locationId: "centro" }

  it("como mucho 500 filas y al menos una", () => {
    const fila = { guestName: "Ana" }
    expect(ImportarReservasInputSchema.safeParse({ ...ref, rows: Array.from({ length: IMPORT_MAX_ROWS }, () => fila) }).success).toBe(true)
    expect(errores(ImportarReservasInputSchema.safeParse({ ...ref, rows: Array.from({ length: 501 }, () => fila) }))).toEqual(["rows: Como mucho 500 filas."])
    expect(errores(ImportarReservasInputSchema.safeParse({ ...ref, rows: [] }))).toEqual(["rows: No hay filas."])
    expect(ImportarReservasInputSchema.parse({ ...ref, rows: [fila] }).dryRun).toBe(false)
  })

  it("una fila buena, como sale de una hoja de cálculo española", () => {
    expect(
      parseImportRow(
        { guestName: " Ana Puig ", phone: 612345678, email: "", date: "9/11/2026", time: "9:30", partySize: "4", status: "Confirmada", tables: "S1 + S2", notas: "columna desconocida" },
        0,
      ),
    ).toEqual({
      ok: true,
      value: {
        guestName: "Ana Puig",
        phone: "+34612345678",
        email: null,
        date: "2026-11-09",
        time: "09:30",
        partySize: 4,
        durationMinutes: undefined,
        status: "confirmed",
        language: "es",
        notes: "",
        tables: ["S1", "S2"],
      },
    })
    const r = parseImportRow({ guestName: "Pau", phone: "+44 7700 900123", date: "2026-11-10", time: "21:00:00", partySize: 2, status: "no presentada", language: "CA", durationMinutes: "120" }, 1)
    expect(r.ok && r.value).toMatchObject({ status: "no_show", language: "ca", durationMinutes: 120, time: "21:00", phone: "+447700900123" })
  })

  it("una fila mala da un error por campo con su número de fila", () => {
    expect(parseImportRow({ guestName: "", phone: "123", date: "31/02/2026", time: "25:00", partySize: "cuatro", status: "quizás", email: "no" }, 7)).toEqual({
      ok: false,
      errors: [
        { row: 7, field: "guestName", message: "Falta el nombre." },
        { row: 7, field: "phone", message: "Un teléfono de España tiene 9 cifras y empieza por 6, 7, 8 o 9. Si es de otro país, empieza por + y su prefijo." },
        { row: 7, field: "email", message: "Ese correo no parece válido." },
        { row: 7, field: "date", message: "Fecha no válida: usa 2026-11-09 o 9/11/2026." },
        { row: 7, field: "time", message: "Hora no válida: usa 13:30." },
        { row: 7, field: "partySize", message: "Comensales no válidos." },
        { row: 7, field: "status", message: "Estado no válido: quizás." },
      ],
    })
  })
})
