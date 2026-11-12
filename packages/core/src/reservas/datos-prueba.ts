/**
 * Datos compartidos por las pruebas del motor de reservas. No se exporta desde el paquete.
 */
import { configuracionReservasInicial, type ConfiguracionReservas } from "./horarios"
import type { MesaMotor } from "./ocupacion"
import type { ReservaOcupacion } from "./reserva"

export const MINUTO = 60_000

/** Instante UTC en ms a partir de sus partes (mes de 1 a 12). */
export function utc(a: number, mes: number, dia: number, h: number, m = 0): number {
  return Date.UTC(a, mes - 1, dia, h, m)
}

export function config(cambios: Partial<ConfiguracionReservas> = {}): ConfiguracionReservas {
  return { ...configuracionReservasInicial("Europe/Madrid"), ...cambios }
}

export function mesa(id: string, seats: number, cambios: Partial<MesaMotor> = {}): MesaMotor {
  return { id, name: id, areaId: id.startsWith("T") ? "terraza" : "sala", seats, joinableWith: [], enabled: true, ...cambios }
}

/**
 * Sala: S1 (2) + S2 (2) unibles, S3 (4) + S4 (4) unibles, S5 (6), S6 (2, deshabilitada y unible con S5).
 * Terraza: T1 (2) – T2 (2) – T3 (4) en cadena.
 */
export const MESAS: MesaMotor[] = [
  mesa("S1", 2, { joinableWith: ["S2"] }),
  mesa("S2", 2),
  mesa("S3", 4, { joinableWith: ["S4"] }),
  mesa("S4", 4, { joinableWith: ["S3"] }),
  mesa("S5", 6, { joinableWith: ["S6"] }),
  mesa("S6", 2, { enabled: false }),
  mesa("T1", 2, { joinableWith: ["T2"] }),
  mesa("T2", 2, { joinableWith: ["T1", "T3"] }),
  mesa("T3", 4, { joinableWith: ["T2"] }),
]

let contador = 0

export function reserva(inicio: number, cambios: Partial<ReservaOcupacion> = {}): ReservaOcupacion {
  contador += 1
  return {
    id: `r${contador}`,
    inicio,
    duracionMinutos: 90,
    comensales: 2,
    estado: "confirmada",
    mesaIds: [],
    ...cambios,
  }
}
