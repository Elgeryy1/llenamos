/**
 * Disponibilidad: a qué horas de un día puede llegar un grupo.
 *
 * Una franja está libre si se cumplen, por este orden:
 * 1. la antelación mínima y máxima (salvo que reserve el personal);
 * 2. la capacidad de comensales de la franja y del turno;
 * 3. hay mesa o combinación de mesas libre durante toda la reserva más el margen, sin
 *    dejar sin sitio a las reservas que aún no tienen mesa asignada.
 *
 * Es una función pura: la hora actual (`ahora`) y la zona horaria (en la configuración)
 * entran como datos.
 */
import { cuentaParaCapacidad } from "./estados"
import { duracionParaGrupo, franjasDelDia, turnosDelDia, type ConfiguracionReservas, type FranjaHoraria } from "./horarios"
import {
  combinacionesDeMesas,
  construirOcupacion,
  encajarSolicitudes,
  opcionesParaGrupo,
  solicitudesSinMesa,
  type MesaMotor,
  type OpcionMesas,
} from "./ocupacion"
import type { ReservaOcupacion } from "./reserva"
import { horaLocal, minutosAHora, type Fecha, type Hora } from "./tiempo"

const MINUTO = 60_000
const DIA = 24 * 60 * MINUTO

export type MotivoFranja = "antelacion_minima" | "antelacion_maxima" | "capacidad_franja" | "capacidad_turno" | "sin_mesa"

export const MOTIVO_FRANJA_TEXTO: Record<MotivoFranja, string> = {
  antelacion_minima: "Falta muy poco para esa hora; llama al restaurante.",
  antelacion_maxima: "Todavía no se puede reservar para esa fecha.",
  capacidad_franja: "Ya llegan demasiados comensales a esa hora.",
  capacidad_turno: "El turno está completo.",
  sin_mesa: "No queda ninguna mesa libre para ese grupo.",
}

export interface FranjaDisponible extends FranjaHoraria {
  disponible: boolean
  motivo: MotivoFranja | null
  /** Comensales que ya llegan en esta franja (sin contar el grupo nuevo). */
  comensalesEnFranja: number
}

export interface Disponibilidad {
  fecha: Fecha
  comensales: number
  duracionMinutos: number
  /** cerrado: el local no abre; grupo_no_admitido: ese tamaño de grupo no se puede reservar. */
  estado: "abierto" | "cerrado" | "grupo_no_admitido"
  /** Explicación para enseñar, o null. */
  mensaje: string | null
  franjas: FranjaDisponible[]
}

export interface EntradaDisponibilidad {
  config: ConfiguracionReservas
  /** Día de servicio. */
  fecha: Fecha
  comensales: number
  mesas: readonly MesaMotor[]
  /** Reservas del local (pueden incluir otros días; solo cuentan las que coinciden). */
  reservas: readonly ReservaOcupacion[]
  /** Instante actual en ms UTC. */
  ahora: number
  /** Duración a medida; si falta, la de los tramos de la configuración. */
  duracionMinutos?: number
  /** El personal puede saltarse la antelación y el tamaño de grupo de la web pública. */
  ignorarLimitesPublicos?: boolean
  /** Al mover una reserva, para que no choque consigo misma. */
  excluirReservaId?: string
}

/** Clave de la franja en la que cae un instante: fecha y hora de pared redondeada hacia abajo al paso. */
function claveFranja(instante: number, config: ConfiguracionReservas): string {
  const local = horaLocal(instante, config.zonaHoraria)
  const redondeado = Math.floor(local.minutos / config.pasoMinutos) * config.pasoMinutos
  return `${local.fecha} ${minutosAHora(redondeado)}`
}

/** Crea un buscador de opciones de mesa por tamaño de grupo, calculando cada tamaño una sola vez. */
export function buscadorDeOpciones(
  config: ConfiguracionReservas,
  mesas: readonly MesaMotor[],
  zonaPreferida?: string | null,
): (comensales: number) => OpcionMesas[] {
  const combinaciones = combinacionesDeMesas(mesas, config.maxMesasUnidas, config.plazasPerdidasPorUnion)
  const cache = new Map<number, OpcionMesas[]>()
  return (comensales) => {
    let opciones = cache.get(comensales)
    if (!opciones) {
      opciones = opcionesParaGrupo(combinaciones, mesas, comensales, zonaPreferida)
      cache.set(comensales, opciones)
    }
    return opciones
  }
}

export function calcularDisponibilidad(entrada: EntradaDisponibilidad): Disponibilidad {
  const { config, fecha, comensales, mesas, reservas, ahora } = entrada
  if (!Number.isInteger(comensales) || comensales < 1) {
    throw new Error(`Número de comensales no válido: ${comensales}.`)
  }
  const duracionMinutos = entrada.duracionMinutos ?? duracionParaGrupo(config, comensales)
  const base = { fecha, comensales, duracionMinutos }

  const dia = turnosDelDia(config, fecha)
  if (!dia.abierto) return { ...base, estado: "cerrado", mensaje: dia.motivo, franjas: [] }

  if (!entrada.ignorarLimitesPublicos) {
    if (comensales < config.comensalesMin) {
      return { ...base, estado: "grupo_no_admitido", mensaje: `El mínimo para reservar es de ${config.comensalesMin} comensales.`, franjas: [] }
    }
    if (comensales > config.comensalesMax) {
      return {
        ...base,
        estado: "grupo_no_admitido",
        mensaje: `Para grupos de más de ${config.comensalesMax}, llama al restaurante.`,
        franjas: [],
      }
    }
  }

  const opcionesPara = buscadorDeOpciones(config, mesas)
  const opcionesNuevo = opcionesPara(comensales)
  if (opcionesNuevo.length === 0) {
    return {
      ...base,
      estado: "grupo_no_admitido",
      mensaje: `Ninguna mesa ni combinación de mesas tiene sitio para ${comensales}.`,
      franjas: [],
    }
  }

  // Comensales que llegan en cada franja (para la capacidad).
  const contadas = reservas.filter((r) => r.id !== entrada.excluirReservaId && cuentaParaCapacidad(r.estado))
  const porFranja = new Map<string, number>()
  for (const r of contadas) {
    const clave = claveFranja(r.inicio, config)
    porFranja.set(clave, (porFranja.get(clave) ?? 0) + r.comensales)
  }

  const franjasBase = franjasDelDia(config, fecha)

  // Tramo de cada turno, para la capacidad del turno: desde su primera franja hasta el final de la última.
  const tramoTurno = new Map<number, { inicio: number; fin: number }>()
  for (const f of franjasBase) {
    const t = tramoTurno.get(f.indiceTurno)
    const fin = f.inicio + config.pasoMinutos * MINUTO
    if (!t) tramoTurno.set(f.indiceTurno, { inicio: f.inicio, fin })
    else tramoTurno.set(f.indiceTurno, { inicio: Math.min(t.inicio, f.inicio), fin: Math.max(t.fin, fin) })
  }
  const comensalesTurno = (indice: number) => {
    const t = tramoTurno.get(indice)
    if (!t) return 0
    return contadas.filter((r) => r.inicio >= t.inicio && r.inicio < t.fin).reduce((s, r) => s + r.comensales, 0)
  }

  const ocupacion = construirOcupacion(reservas, ahora, entrada.excluirReservaId)

  const franjas = franjasBase.map((f): FranjaDisponible => {
    const comensalesEnFranja = porFranja.get(`${f.fecha} ${f.hora}`) ?? 0
    const resultado = (motivo: MotivoFranja | null): FranjaDisponible => ({
      ...f,
      disponible: motivo === null,
      motivo,
      comensalesEnFranja,
    })
    const turno = dia.turnos[f.indiceTurno]

    if (!entrada.ignorarLimitesPublicos) {
      if (f.inicio - ahora < config.antelacionMinimaMinutos * MINUTO) return resultado("antelacion_minima")
      if (f.inicio - ahora > config.antelacionMaximaDias * DIA) return resultado("antelacion_maxima")
    }

    const maxFranja = turno?.maxComensalesPorFranja ?? config.maxComensalesPorFranja
    if (maxFranja !== null && comensalesEnFranja + comensales > maxFranja) return resultado("capacidad_franja")

    const maxTurno = turno?.maxComensalesTurno
    if (maxTurno !== undefined && comensalesTurno(f.indiceTurno) + comensales > maxTurno) return resultado("capacidad_turno")

    const intervalo = { inicio: f.inicio, fin: f.inicio + duracionMinutos * MINUTO }
    const solicitudes = [
      { id: "\u0000nueva", intervalo, comensales, opciones: opcionesNuevo },
      ...solicitudesSinMesa(intervalo, ocupacion, config.margenMinutos, opcionesPara),
    ]
    const encaje = encajarSolicitudes(solicitudes, ocupacion, config.margenMinutos)
    return resultado(encaje.tipo === "encaja" ? null : "sin_mesa")
  })

  return { ...base, estado: "abierto", mensaje: null, franjas }
}

/** Solo las horas a las que se puede llegar, en orden. */
export function horasDisponibles(disponibilidad: Disponibilidad): Hora[] {
  return disponibilidad.franjas.filter((f) => f.disponible).map((f) => f.hora)
}
