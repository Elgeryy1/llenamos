/**
 * Horarios de reservas de un local.
 *
 * - Cada día de la semana tiene cero o más turnos (comida, cena…). Sin turnos = cerrado.
 * - Un turno va de `desde` a `ultimaEntrada` (la última hora a la que se puede llegar),
 *   ambas incluidas, en saltos de `pasoMinutos`. Si `ultimaEntrada` es menor que `desde`,
 *   el turno cruza la medianoche y sus últimas franjas caen en el día siguiente, pero
 *   siguen perteneciendo al día de servicio en que empezó.
 * - Excepciones por fecha: cerrar un día concreto o darle un horario especial.
 * - Cierres por periodo: vacaciones, obras…
 *
 * Orden de prioridad para saber qué turnos hay un día: excepción de esa fecha, después
 * cierre por periodo, después horario semanal. La excepción gana porque es lo más concreto
 * (por ejemplo, abrir un día suelto en mitad de las vacaciones).
 */
import { z } from "zod"
import {
  DIA_SEMANA_LABEL,
  diaSemana,
  FechaSchema,
  HoraSchema,
  horaAMinutos,
  instanteDeHoraLocal,
  minutosAHora,
  sumarDias,
  ZonaHorariaSchema,
  type Fecha,
  type Hora,
} from "./tiempo"

export const PASOS_PERMITIDOS = [5, 10, 15, 20, 30, 60] as const

export const TurnoSchema = z.object({
  nombre: z.string().trim().min(1).max(40),
  desde: HoraSchema,
  ultimaEntrada: HoraSchema,
  /** Máximo de comensales que pueden llegar en una misma franja. Si falta, se usa el del local. */
  maxComensalesPorFranja: z.number().int().min(1).optional(),
  /** Máximo de comensales en todo el turno. Si falta, no hay límite. */
  maxComensalesTurno: z.number().int().min(1).optional(),
})
export type Turno = z.infer<typeof TurnoSchema>

/** Minutos de inicio y de última entrada del turno, sumando 1440 si cruza la medianoche. */
export function rangoTurno(turno: Pick<Turno, "desde" | "ultimaEntrada">): { desde: number; ultimaEntrada: number } {
  const desde = horaAMinutos(turno.desde)
  let ultimaEntrada = horaAMinutos(turno.ultimaEntrada)
  if (ultimaEntrada < desde) ultimaEntrada += 1440
  return { desde, ultimaEntrada }
}

export function cruzaMedianoche(turno: Pick<Turno, "desde" | "ultimaEntrada">): boolean {
  return horaAMinutos(turno.ultimaEntrada) < horaAMinutos(turno.desde)
}

/** Turnos de un día: no se pueden pisar entre sí. */
export const TurnosDelDiaSchema = z.array(TurnoSchema).superRefine((turnos, ctx) => {
  // zod sigue con esta comprobación aunque alguna hora esté mal escrita; esas ya tienen su error.
  const horasBien = (t: Turno) => HoraSchema.safeParse(t.desde).success && HoraSchema.safeParse(t.ultimaEntrada).success
  if (!turnos.every(horasBien)) return
  const rangos = turnos.map((t) => rangoTurno(t))
  for (let i = 0; i < rangos.length; i++) {
    for (let j = i + 1; j < rangos.length; j++) {
      const a = rangos[i]
      const b = rangos[j]
      if (a && b && a.desde <= b.ultimaEntrada && b.desde <= a.ultimaEntrada) {
        ctx.addIssue({
          code: "custom",
          path: [j],
          message: `El turno «${turnos[j]?.nombre}» se pisa con «${turnos[i]?.nombre}».`,
        })
      }
    }
  }
})

export const HorarioSemanalSchema = z.object({
  lun: TurnosDelDiaSchema,
  mar: TurnosDelDiaSchema,
  mie: TurnosDelDiaSchema,
  jue: TurnosDelDiaSchema,
  vie: TurnosDelDiaSchema,
  sab: TurnosDelDiaSchema,
  dom: TurnosDelDiaSchema,
})
export type HorarioSemanal = z.infer<typeof HorarioSemanalSchema>

export const ExcepcionSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("cerrado"),
    fecha: FechaSchema,
    motivo: z.string().trim().max(120).optional(),
  }),
  z.object({
    tipo: z.literal("horario"),
    fecha: FechaSchema,
    turnos: TurnosDelDiaSchema.min(1, "Un horario especial necesita al menos un turno; si no, usa «cerrado»."),
    motivo: z.string().trim().max(120).optional(),
  }),
])
export type Excepcion = z.infer<typeof ExcepcionSchema>

export const CierreSchema = z
  .object({
    desde: FechaSchema,
    hasta: FechaSchema,
    motivo: z.string().trim().max(120).optional(),
  })
  .refine((c) => c.desde <= c.hasta, { message: "El cierre termina antes de empezar.", path: ["hasta"] })
export type Cierre = z.infer<typeof CierreSchema>

export const TramoDuracionSchema = z.object({
  /** El tramo vale para grupos de hasta este número de comensales (incluido). */
  hastaComensales: z.number().int().min(1),
  minutos: z.number().int().min(15).max(24 * 60),
})

export const ConfiguracionReservasSchema = z
  .object({
    /** Zona horaria del local. En España peninsular, "Europe/Madrid". */
    zonaHoraria: ZonaHorariaSchema,
    /** Salto entre horas ofrecidas. Por defecto, 15 minutos. */
    pasoMinutos: z
      .number()
      .int()
      .refine((n) => (PASOS_PERMITIDOS as readonly number[]).includes(n), "Usa 5, 10, 15, 20, 30 o 60 minutos."),
    semana: HorarioSemanalSchema,
    excepciones: z.array(ExcepcionSchema),
    cierres: z.array(CierreSchema),
    duracion: z.object({
      /** Para grupos más grandes que el último tramo. */
      porDefectoMinutos: z.number().int().min(15).max(24 * 60),
      tramos: z.array(TramoDuracionSchema),
    }),
    /** Minutos que se dejan libres entre una reserva y la siguiente en la misma mesa (recoger y montar). */
    margenMinutos: z.number().int().min(0).max(240),
    /** Máximo de comensales que pueden llegar en una misma franja (para no ahogar a la cocina). null = sin límite. */
    maxComensalesPorFranja: z.number().int().min(1).nullable(),
    /** Tamaño de grupo que se acepta desde la web pública. */
    comensalesMin: z.number().int().min(1),
    comensalesMax: z.number().int().min(1),
    /** No se puede reservar una hora que empiece antes de estos minutos desde ahora. */
    antelacionMinimaMinutos: z.number().int().min(0),
    /** Ni con más de estos días de antelación. */
    antelacionMaximaDias: z.number().int().min(1).max(730),
    /** Cuántas mesas se pueden juntar como mucho para un grupo. 1 = no se juntan. */
    maxMesasUnidas: z.number().int().min(1).max(6),
    /** Plazas que se pierden en cada unión de mesas (las esquinas que quedan pegadas). */
    plazasPerdidasPorUnion: z.number().int().min(0).max(4),
  })
  .superRefine((c, ctx) => {
    // Se ejecuta aunque falten campos (ya tienen su error): se leen con cuidado.
    if (c.comensalesMin > c.comensalesMax) {
      ctx.addIssue({ code: "custom", path: ["comensalesMax"], message: "El máximo de comensales es menor que el mínimo." })
    }
    const vistas = new Set<string>()
    const excepciones = Array.isArray(c.excepciones) ? c.excepciones : []
    excepciones.forEach((e, i) => {
      const fecha = e?.fecha
      if (typeof fecha !== "string") return
      if (vistas.has(fecha)) {
        ctx.addIssue({ code: "custom", path: ["excepciones", i, "fecha"], message: `Hay dos excepciones para el ${fecha}.` })
      }
      vistas.add(fecha)
    })
    const tramos = Array.isArray(c.duracion?.tramos) ? c.duracion.tramos : []
    for (let i = 1; i < tramos.length; i++) {
      const anterior = tramos[i - 1]
      const actual = tramos[i]
      if (anterior && actual && actual.hastaComensales <= anterior.hastaComensales) {
        ctx.addIssue({
          code: "custom",
          path: ["duracion", "tramos", i],
          message: "Los tramos de duración deben ir de menos a más comensales.",
        })
      }
    }
  })
export type ConfiguracionReservas = z.infer<typeof ConfiguracionReservasSchema>

/** Configuración de partida para un restaurante típico: comida y cena, cerrado el lunes. */
export function configuracionReservasInicial(zonaHoraria = "Europe/Madrid"): ConfiguracionReservas {
  const comida: Turno = { nombre: "Comida", desde: "13:00", ultimaEntrada: "15:30" }
  const cena: Turno = { nombre: "Cena", desde: "20:00", ultimaEntrada: "22:30" }
  return {
    zonaHoraria,
    pasoMinutos: 15,
    semana: {
      lun: [],
      mar: [comida, cena],
      mie: [comida, cena],
      jue: [comida, cena],
      vie: [comida, cena],
      sab: [comida, cena],
      dom: [comida],
    },
    excepciones: [],
    cierres: [],
    duracion: {
      porDefectoMinutos: 150,
      tramos: [
        { hastaComensales: 2, minutos: 90 },
        { hastaComensales: 4, minutos: 105 },
        { hastaComensales: 6, minutos: 120 },
      ],
    },
    margenMinutos: 15,
    maxComensalesPorFranja: null,
    comensalesMin: 1,
    comensalesMax: 12,
    antelacionMinimaMinutos: 60,
    antelacionMaximaDias: 90,
    maxMesasUnidas: 3,
    plazasPerdidasPorUnion: 0,
  }
}

/** Minutos que dura la reserva de un grupo según los tramos. */
export function duracionParaGrupo(config: Pick<ConfiguracionReservas, "duracion">, comensales: number): number {
  for (const tramo of config.duracion.tramos) {
    if (comensales <= tramo.hastaComensales) return tramo.minutos
  }
  return config.duracion.porDefectoMinutos
}

export interface DiaDeServicio {
  fecha: Fecha
  abierto: boolean
  /** De dónde sale el horario de ese día. */
  origen: "semana" | "excepcion" | "cierre"
  /** Explicación para enseñar, o null si abre con normalidad. */
  motivo: string | null
  turnos: Turno[]
}

/** Qué turnos tiene el local en una fecha (día de servicio). */
export function turnosDelDia(config: ConfiguracionReservas, fecha: Fecha): DiaDeServicio {
  const excepcion = config.excepciones.find((e) => e.fecha === fecha)
  if (excepcion) {
    if (excepcion.tipo === "cerrado") {
      return { fecha, abierto: false, origen: "excepcion", motivo: excepcion.motivo ?? "Cerrado ese día.", turnos: [] }
    }
    return { fecha, abierto: true, origen: "excepcion", motivo: excepcion.motivo ?? "Horario especial.", turnos: excepcion.turnos }
  }
  const cierre = config.cierres.find((c) => c.desde <= fecha && fecha <= c.hasta)
  if (cierre) {
    return { fecha, abierto: false, origen: "cierre", motivo: cierre.motivo ?? "Cerrado por vacaciones.", turnos: [] }
  }
  const dia = diaSemana(fecha)
  const turnos = config.semana[dia]
  if (turnos.length === 0) {
    return { fecha, abierto: false, origen: "semana", motivo: `Cerrado los ${plural(DIA_SEMANA_LABEL[dia])}.`, turnos: [] }
  }
  return { fecha, abierto: true, origen: "semana", motivo: null, turnos }
}

/** «lunes» → «lunes», «sábado» → «sábados». */
function plural(dia: string): string {
  return dia.endsWith("s") ? dia : `${dia}s`
}

export interface FranjaHoraria {
  /** Instante de llegada en ms UTC. */
  inicio: number
  /** Fecha y hora de pared en el local (puede ser el día siguiente si el turno cruza la medianoche). */
  fecha: Fecha
  hora: Hora
  /** Día de servicio al que pertenece. */
  fechaServicio: Fecha
  turno: string
  indiceTurno: number
}

/**
 * Franjas de llegada de un día de servicio, en orden.
 *
 * Cambios de hora: las horas que no existen (adelanto de marzo) no se ofrecen, y las
 * que se repiten (retraso de octubre) se ofrecen una sola vez, la primera.
 */
export function franjasDelDia(config: ConfiguracionReservas, fecha: Fecha): FranjaHoraria[] {
  const dia = turnosDelDia(config, fecha)
  const franjas: FranjaHoraria[] = []
  dia.turnos.forEach((turno, indiceTurno) => {
    const { desde, ultimaEntrada } = rangoTurno(turno)
    for (let m = desde; m <= ultimaEntrada; m += config.pasoMinutos) {
      const fechaPared = m >= 1440 ? sumarDias(fecha, 1) : fecha
      const minutos = m % 1440
      const inicio = instanteDeHoraLocal(fechaPared, minutos, config.zonaHoraria)
      if (inicio === null) continue
      franjas.push({ inicio, fecha: fechaPared, hora: minutosAHora(minutos), fechaServicio: fecha, turno: turno.nombre, indiceTurno })
    }
  })
  return franjas.sort((a, b) => a.inicio - b.inicio)
}
