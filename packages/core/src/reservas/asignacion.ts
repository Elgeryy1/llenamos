/**
 * Asignación de mesa: propone la mejor mesa o combinación de mesas unibles para un
 * grupo a una hora, y explica por qué (y por qué no las otras), para que el encargado
 * decida. El motor nunca asigna solo: sugiere.
 *
 * Criterio, de más a menos importante:
 * 1. libre durante toda la reserva más el margen;
 * 2. que no deje sin sitio a las reservas que aún no tienen mesa;
 * 3. en la zona pedida, si se pidió una;
 * 4. menos plazas vacías;
 * 5. menos mesas unidas;
 * 6. el orden de las mesas en el plano (para que el resultado sea siempre el mismo).
 */
import { duracionParaGrupo, type ConfiguracionReservas } from "./horarios"
import { buscadorDeOpciones } from "./disponibilidad"
import {
  choquesDeMesa,
  construirOcupacion,
  encajarSolicitudes,
  solicitudesSinMesa,
  type MesaMotor,
  type OpcionMesas,
  type Ocupacion,
} from "./ocupacion"
import type { ReservaOcupacion } from "./reserva"
import { horaLocal } from "./tiempo"

const MINUTO = 60_000

export interface PeticionMesa {
  /** Instante de llegada en ms UTC. */
  inicio: number
  comensales: number
  /** Duración a medida; si falta, la de los tramos de la configuración. */
  duracionMinutos?: number
  /** Si se busca mesa para una reserva que ya existe, su id (para que no choque consigo misma). */
  reservaId?: string
  /** areaId de la zona que pidió el cliente (terraza, sala…). */
  zonaPreferida?: string | null
}

export interface EntradaAsignacion {
  config: ConfiguracionReservas
  mesas: readonly MesaMotor[]
  reservas: readonly ReservaOcupacion[]
  /** Instante actual en ms UTC. */
  ahora: number
  peticion: PeticionMesa
  /** Cuántas propuestas devolver como mucho. Por defecto, 3. */
  limite?: number
}

export interface PropuestaMesas {
  mesaIds: string[]
  nombres: string[]
  plazas: number
  sobran: number
  unidas: boolean
  /** null si no se pidió zona. */
  enZonaPreferida: boolean | null
  explicacion: string
}

export type MotivoDescarte = "deshabilitada" | "ocupada" | "pequena" | "dejaria_sin_mesa" | "sin_comprobar"

export interface DescarteMesas {
  mesaIds: string[]
  nombres: string[]
  motivo: MotivoDescarte
  explicacion: string
  /** Reservas con las que choca o a las que dejaría sin sitio. */
  reservaIds: string[]
}

export interface ResultadoAsignacion {
  inicio: number
  comensales: number
  duracionMinutos: number
  /** De mejor a peor; la primera es la recomendada. */
  propuestas: PropuestaMesas[]
  /** Cuántas opciones válidas hay en total (puede haber más que `propuestas`). */
  totalOpciones: number
  descartes: DescarteMesas[]
  /** Una frase para el encargado. */
  resumen: string
}

function plural(n: number, singular: string, pluralTexto: string): string {
  return `${n} ${n === 1 ? singular : pluralTexto}`
}

function textoSobran(sobran: number): string {
  if (sobran === 0) return "no sobra ninguna"
  return sobran === 1 ? "sobra 1" : `sobran ${sobran}`
}

/** Las reservas con mesa más una opción nueva ocupada durante un intervalo. */
function conOpcionOcupada(ocupacion: Ocupacion, opcion: OpcionMesas, intervalo: { inicio: number; fin: number }): Pick<Ocupacion, "porMesa"> {
  const porMesa = new Map(ocupacion.porMesa)
  for (const id of opcion.mesaIds) {
    porMesa.set(id, [...(porMesa.get(id) ?? []), { ...intervalo, reservaId: "\u0000peticion" }])
  }
  return { porMesa }
}

export function proponerMesas(entrada: EntradaAsignacion): ResultadoAsignacion {
  const { config, mesas, reservas, ahora, peticion } = entrada
  const { comensales, inicio } = peticion
  if (!Number.isInteger(comensales) || comensales < 1) {
    throw new Error(`Número de comensales no válido: ${comensales}.`)
  }
  const limite = entrada.limite ?? 3
  const duracionMinutos = peticion.duracionMinutos ?? duracionParaGrupo(config, comensales)
  const intervalo = { inicio, fin: inicio + duracionMinutos * MINUTO }
  const margen = config.margenMinutos
  const zona = peticion.zonaPreferida ?? null
  const hora = (ms: number) => horaLocal(ms, config.zonaHoraria).hora
  const porId = new Map(mesas.map((m) => [m.id, m]))
  const nombresDe = (ids: readonly string[]) => ids.map((id) => porId.get(id)?.name ?? id)

  const ocupacion = construirOcupacion(reservas, ahora, peticion.reservaId)
  const descartes: DescarteMesas[] = []

  // 1. Mesas que no se pueden usar de ninguna forma a esa hora.
  const noUsables = new Set<string>()
  for (const m of mesas) {
    if (!m.enabled) {
      noUsables.add(m.id)
      descartes.push({
        mesaIds: [m.id],
        nombres: [m.name],
        motivo: "deshabilitada",
        explicacion: `Mesa ${m.name}: está deshabilitada.`,
        reservaIds: [],
      })
      continue
    }
    const choques = choquesDeMesa(ocupacion, m.id, intervalo, margen)
    const primero = choques[0]
    if (primero) {
      noUsables.add(m.id)
      const conMargen = margen > 0 ? `, más ${margen} minutos de margen` : ""
      descartes.push({
        mesaIds: [m.id],
        nombres: [m.name],
        motivo: "ocupada",
        explicacion: `Mesa ${m.name}: ocupada por otra reserva de ${hora(primero.inicio)} a ${hora(primero.fin)}${conMargen}.`,
        reservaIds: [...new Set(choques.map((c) => c.reservaId))],
      })
    }
  }

  // 2. Opciones libres, en orden de preferencia, que no dejen sin sitio a las reservas sin mesa.
  const opcionesNuevo = buscadorDeOpciones(config, mesas, zona)(comensales)
  const opcionesOtras = buscadorDeOpciones(config, mesas)
  const otras = solicitudesSinMesa(intervalo, ocupacion, margen, opcionesOtras)
  const validas: OpcionMesas[] = []
  for (const opcion of opcionesNuevo) {
    if (opcion.mesaIds.some((id) => noUsables.has(id))) continue
    if (otras.length > 0) {
      const encaje = encajarSolicitudes(otras, conOpcionOcupada(ocupacion, opcion, intervalo), margen)
      if (encaje.tipo !== "encaja") {
        // Solo interesa explicar las opciones que habrían sido mejores que la recomendada.
        if (validas.length === 0 && descartes.filter((d) => d.motivo === "dejaria_sin_mesa" || d.motivo === "sin_comprobar").length < 5) {
          const nombres = nombresDe(opcion.mesaIds)
          const etiqueta = opcion.mesaIds.length > 1 ? `Mesas ${nombres.join(" + ")}` : `Mesa ${nombres[0]}`
          descartes.push({
            mesaIds: opcion.mesaIds,
            nombres,
            motivo: encaje.tipo === "no_encaja" ? "dejaria_sin_mesa" : "sin_comprobar",
            explicacion:
              encaje.tipo === "no_encaja"
                ? `${etiqueta}: libre, pero dejaría sin sitio a reservas que todavía no tienen mesa.`
                : `${etiqueta}: hay demasiadas reservas sin mesa para comprobar si cabrían todas.`,
            reservaIds: otras.map((o) => o.id),
          })
        }
        continue
      }
    }
    validas.push(opcion)
  }

  // 3. Mesas libres demasiado pequeñas que no forman parte de ninguna opción válida.
  const usadas = new Set(validas.flatMap((o) => o.mesaIds))
  for (const m of mesas) {
    if (noUsables.has(m.id) || usadas.has(m.id) || m.seats >= comensales) continue
    // joinableWith se lee en los dos sentidos, como en combinacionesDeMesas.
    const unible = m.joinableWith.some((id) => porId.has(id) && id !== m.id) || mesas.some((o) => o.id !== m.id && o.joinableWith.includes(m.id))
    const union = config.maxMesasUnidas > 1 && unible
    descartes.push({
      mesaIds: [m.id],
      nombres: [m.name],
      motivo: "pequena",
      explicacion: `Mesa ${m.name}: tiene ${plural(m.seats, "plaza", "plazas")} y el grupo es de ${comensales}${
        union ? "; ni uniéndola a sus mesas libres hay sitio" : "; no se puede unir con otras"
      }.`,
      reservaIds: [],
    })
  }

  // 4. Propuestas con su explicación.
  const mejorSola = validas.find((o) => o.mesaIds.length === 1)
  const propuestas = validas.slice(0, limite).map((opcion): PropuestaMesas => {
    const nombres = nombresDe(opcion.mesaIds)
    const unidas = opcion.mesaIds.length > 1
    const sobran = opcion.plazas - comensales
    const enZonaPreferida = zona === null ? null : opcion.areaIds.every((a) => a === zona)
    const partes: string[] = []
    if (unidas) {
      const asientos = opcion.mesaIds.map((id) => porId.get(id)?.seats ?? 0)
      const perdidas = (opcion.mesaIds.length - 1) * config.plazasPerdidasPorUnion
      const detalle = `${asientos.join(" + ")}${perdidas > 0 ? `, menos ${perdidas} al unirlas` : ""}`
      partes.push(`Mesas ${nombres.join(" + ")} unidas: ${opcion.plazas} plazas (${detalle}) para ${comensales}; ${textoSobran(sobran)}.`)
      if (!mejorSola) {
        partes.push(`Se unen porque ninguna mesa sola libre tiene sitio para ${comensales}.`)
      } else if (mejorSola.plazas - comensales > sobran) {
        const nombreSola = nombresDe(mejorSola.mesaIds)[0]
        partes.push(
          `Se unen porque así sobran menos plazas que en la mesa ${nombreSola} sola (${textoSobran(mejorSola.plazas - comensales)}).`,
        )
      }
    } else {
      partes.push(`Mesa ${nombres[0]}: ${plural(opcion.plazas, "plaza", "plazas")} para ${comensales}; ${textoSobran(sobran)}.`)
    }
    if (enZonaPreferida === true) partes.push("Está en la zona pedida.")
    if (enZonaPreferida === false) partes.push("No está en la zona pedida: allí no queda sitio para este grupo.")
    return { mesaIds: opcion.mesaIds, nombres, plazas: opcion.plazas, sobran, unidas, enZonaPreferida, explicacion: partes.join(" ") }
  })

  let resumen: string
  const primera = propuestas[0]
  if (!primera) {
    resumen =
      opcionesNuevo.length === 0
        ? `Ninguna mesa ni combinación de mesas tiene sitio para ${comensales}.`
        : `No queda mesa libre para ${comensales} a las ${hora(inicio)}.`
  } else {
    const etiqueta = primera.unidas ? `las mesas ${primera.nombres.join(" + ")} unidas` : `la mesa ${primera.nombres[0]}`
    const resto = validas.length - 1
    resumen = `Se propone ${etiqueta}: es la opción libre en la que sobran menos plazas${
      primera.enZonaPreferida ? " dentro de la zona pedida" : ""
    }.${resto > 0 ? ` Hay ${plural(resto, "alternativa", "alternativas")}.` : ""}`
  }

  return { inicio, comensales, duracionMinutos, propuestas, totalOpciones: validas.length, descartes, resumen }
}
