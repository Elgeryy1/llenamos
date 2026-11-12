/**
 * Mesas, combinaciones de mesas y ocupación en el tiempo.
 *
 * Todo se compara en instantes (ms UTC), así que una reserva que cruza un cambio de
 * hora dura lo que tiene que durar.
 */
import type { Table } from "../model"
import { ocupaMesa } from "./estados"
import type { ReservaOcupacion } from "./reserva"

const MINUTO = 60_000

/** Lo que el motor necesita de una mesa: el documento de `tables/{tid}` con su id. */
export type MesaMotor = Pick<Table, "name" | "areaId" | "seats" | "joinableWith" | "enabled"> & { id: string }

/** Una mesa sola o un grupo de mesas unibles que se juntan. */
export interface OpcionMesas {
  /** En el orden en que llegan las mesas. */
  mesaIds: string[]
  /** Plazas reales, descontando las que se pierden al unir. */
  plazas: number
  /** Zonas que ocupa (normalmente una). */
  areaIds: string[]
}

/**
 * Todas las mesas habilitadas y todas las combinaciones de mesas unibles de hasta
 * `maxUnidas` mesas. Una combinación vale si las mesas forman una cadena o grupo
 * conectado según `joinableWith`.
 *
 * `joinableWith` se lee en los dos sentidos: basta con que una de las dos mesas diga
 * que se puede unir con la otra. Las mesas deshabilitadas o que no existen se ignoran.
 */
export function combinacionesDeMesas(
  mesas: readonly MesaMotor[],
  maxUnidas: number,
  plazasPerdidasPorUnion: number,
): OpcionMesas[] {
  const orden = new Map(mesas.map((m, i) => [m.id, i]))
  const habilitadas = mesas.filter((m) => m.enabled)
  const porId = new Map(habilitadas.map((m) => [m.id, m]))
  const vecinos = new Map<string, Set<string>>(habilitadas.map((m) => [m.id, new Set<string>()]))
  for (const m of habilitadas) {
    for (const otra of m.joinableWith) {
      if (otra === m.id || !porId.has(otra)) continue
      vecinos.get(m.id)?.add(otra)
      vecinos.get(otra)?.add(m.id)
    }
  }

  const porOrden = (a: string, b: string) => (orden.get(a) ?? 0) - (orden.get(b) ?? 0)
  const todas = new Map<string, string[]>()
  let nivel: string[][] = habilitadas.map((m) => [m.id])
  for (const conjunto of nivel) todas.set(conjunto.join("|"), conjunto)

  for (let tam = 2; tam <= maxUnidas; tam++) {
    const siguiente = new Map<string, string[]>()
    for (const conjunto of nivel) {
      for (const id of conjunto) {
        for (const v of vecinos.get(id) ?? []) {
          if (conjunto.includes(v)) continue
          const nuevo = [...conjunto, v].sort(porOrden)
          const clave = nuevo.join("|")
          if (!todas.has(clave) && !siguiente.has(clave)) siguiente.set(clave, nuevo)
        }
      }
    }
    nivel = [...siguiente.values()]
    if (nivel.length === 0) break
    for (const conjunto of nivel) todas.set(conjunto.join("|"), conjunto)
  }

  return [...todas.values()].map((ids) => {
    const elegidas = ids.map((id) => porId.get(id)).filter((m): m is MesaMotor => m !== undefined)
    const asientos = elegidas.reduce((s, m) => s + m.seats, 0)
    return {
      mesaIds: ids,
      plazas: asientos - (ids.length - 1) * plazasPerdidasPorUnion,
      areaIds: [...new Set(elegidas.map((m) => m.areaId))],
    }
  })
}

/**
 * Opciones en las que cabe el grupo, de mejor a peor:
 * 1. en la zona pedida, si se pidió una;
 * 2. menos plazas vacías;
 * 3. menos mesas (no se juntan mesas si no hace falta);
 * 4. el orden de las mesas en el plano, para que el resultado sea siempre el mismo.
 */
export function opcionesParaGrupo(
  combinaciones: readonly OpcionMesas[],
  mesas: readonly MesaMotor[],
  comensales: number,
  zonaPreferida?: string | null,
): OpcionMesas[] {
  const orden = new Map(mesas.map((m, i) => [m.id, i]))
  const enZona = (o: OpcionMesas) => (zonaPreferida && o.areaIds.every((a) => a === zonaPreferida) ? 0 : 1)
  return combinaciones
    .filter((o) => o.plazas >= comensales)
    .sort((a, b) => {
      if (zonaPreferida) {
        const z = enZona(a) - enZona(b)
        if (z !== 0) return z
      }
      const sobran = a.plazas - b.plazas
      if (sobran !== 0) return sobran
      const num = a.mesaIds.length - b.mesaIds.length
      if (num !== 0) return num
      for (let i = 0; i < a.mesaIds.length; i++) {
        const d = (orden.get(a.mesaIds[i] ?? "") ?? 0) - (orden.get(b.mesaIds[i] ?? "") ?? 0)
        if (d !== 0) return d
      }
      return 0
    })
}

export interface Intervalo {
  /** ms UTC, incluido. */
  inicio: number
  /** ms UTC, excluido. */
  fin: number
}

/**
 * Dos usos de una mesa chocan si no queda el margen entre el final de uno y el
 * principio del otro. Con margen 15, una reserva que acaba a las 21:00 deja libre la
 * mesa a partir de las 21:15.
 */
export function seSolapan(a: Intervalo, b: Intervalo, margenMinutos: number): boolean {
  const margen = margenMinutos * MINUTO
  return a.inicio < b.fin + margen && b.inicio < a.fin + margen
}

/**
 * Tiempo que una reserva tiene la mesa. Si el grupo ya está sentado y se alarga más de
 * lo previsto, la mesa sigue ocupada al menos hasta `ahora`.
 */
export function intervaloDeReserva(r: Pick<ReservaOcupacion, "inicio" | "duracionMinutos" | "estado">, ahora: number): Intervalo {
  const fin = r.inicio + r.duracionMinutos * MINUTO
  return { inicio: r.inicio, fin: r.estado === "sentada" ? Math.max(fin, ahora) : fin }
}

export interface UsoDeMesa extends Intervalo {
  reservaId: string
}

export interface Ocupacion {
  /** Usos de cada mesa por reservas que ya tienen mesa asignada. */
  porMesa: Map<string, UsoDeMesa[]>
  /** Reservas activas que todavía no tienen mesa. */
  sinMesa: Array<{ reserva: ReservaOcupacion; intervalo: Intervalo }>
}

/** Reparte las reservas activas entre las que tienen mesa y las que no. */
export function construirOcupacion(
  reservas: readonly ReservaOcupacion[],
  ahora: number,
  excluirReservaId?: string | null,
): Ocupacion {
  const porMesa = new Map<string, UsoDeMesa[]>()
  const sinMesa: Ocupacion["sinMesa"] = []
  for (const r of reservas) {
    if (r.id === excluirReservaId || !ocupaMesa(r.estado)) continue
    const intervalo = intervaloDeReserva(r, ahora)
    if (r.mesaIds.length === 0) {
      sinMesa.push({ reserva: r, intervalo })
      continue
    }
    for (const id of r.mesaIds) {
      const usos = porMesa.get(id) ?? []
      usos.push({ ...intervalo, reservaId: r.id })
      porMesa.set(id, usos)
    }
  }
  return { porMesa, sinMesa }
}

/** Usos de una mesa que chocan con un intervalo. */
export function choquesDeMesa(
  ocupacion: Pick<Ocupacion, "porMesa">,
  mesaId: string,
  intervalo: Intervalo,
  margenMinutos: number,
): UsoDeMesa[] {
  return (ocupacion.porMesa.get(mesaId) ?? []).filter((u) => seSolapan(u, intervalo, margenMinutos))
}

/**
 * Reservas sin mesa que están encadenadas en el tiempo con el intervalo: las que se
 * solapan con él, las que se solapan con esas, y así. Son las que compiten por las
 * mismas mesas y hay que repartir a la vez.
 */
export function reservasSinMesaEncadenadas(
  intervalo: Intervalo,
  sinMesa: Ocupacion["sinMesa"],
  margenMinutos: number,
): Ocupacion["sinMesa"] {
  const resultado: Ocupacion["sinMesa"] = []
  let frontera: Intervalo[] = [intervalo]
  let resto = [...sinMesa]
  while (frontera.length > 0 && resto.length > 0) {
    const nueva: Intervalo[] = []
    resto = resto.filter((r) => {
      if (frontera.some((f) => seSolapan(f, r.intervalo, margenMinutos))) {
        resultado.push(r)
        nueva.push(r.intervalo)
        return false
      }
      return true
    })
    frontera = nueva
  }
  return resultado
}

export interface Solicitud {
  id: string
  intervalo: Intervalo
  comensales: number
  /** Opciones en orden de preferencia. */
  opciones: readonly OpcionMesas[]
}

export type ResultadoEncaje =
  | { tipo: "encaja"; asignacion: Map<string, OpcionMesas> }
  | { tipo: "no_encaja" }
  /** El reparto era demasiado grande para comprobarlo entero; se trata como si no encajara. */
  | { tipo: "sin_comprobar" }

/** Pasos máximos del reparto. Con plantillas normales (≤ 50 mesas) sobra con mucho. */
export const LIMITE_PASOS_ENCAJE = 20_000

/**
 * ¿Se pueden dar mesas a todas las solicitudes a la vez, sin chocar entre ellas ni con
 * las reservas que ya tienen mesa? Búsqueda con vuelta atrás: primero las solicitudes
 * con menos opciones, y dentro de cada una, las opciones preferidas.
 */
export function encajarSolicitudes(
  solicitudes: readonly Solicitud[],
  ocupacion: Pick<Ocupacion, "porMesa">,
  margenMinutos: number,
  limitePasos = LIMITE_PASOS_ENCAJE,
): ResultadoEncaje {
  const preparadas = solicitudes.map((s) => ({
    s,
    opciones: s.opciones.filter((o) =>
      o.mesaIds.every((id) => choquesDeMesa(ocupacion, id, s.intervalo, margenMinutos).length === 0),
    ),
  }))
  if (preparadas.some((p) => p.opciones.length === 0)) return { tipo: "no_encaja" }
  preparadas.sort((a, b) => a.opciones.length - b.opciones.length || b.s.comensales - a.s.comensales)

  const virtual = new Map<string, Intervalo[]>()
  const asignacion = new Map<string, OpcionMesas>()
  let pasos = 0

  const probar = (i: number): boolean | "limite" => {
    const actual = preparadas[i]
    if (!actual) return true
    for (const opcion of actual.opciones) {
      if (++pasos > limitePasos) return "limite"
      const choca = opcion.mesaIds.some((id) =>
        (virtual.get(id) ?? []).some((iv) => seSolapan(iv, actual.s.intervalo, margenMinutos)),
      )
      if (choca) continue
      for (const id of opcion.mesaIds) virtual.set(id, [...(virtual.get(id) ?? []), actual.s.intervalo])
      asignacion.set(actual.s.id, opcion)
      const r = probar(i + 1)
      if (r === true) return true
      for (const id of opcion.mesaIds) virtual.set(id, (virtual.get(id) ?? []).slice(0, -1))
      asignacion.delete(actual.s.id)
      if (r === "limite") return "limite"
    }
    return false
  }

  const r = probar(0)
  if (r === true) return { tipo: "encaja", asignacion }
  return r === "limite" ? { tipo: "sin_comprobar" } : { tipo: "no_encaja" }
}

/**
 * Prepara las reservas sin mesa encadenadas con un intervalo como solicitudes para
 * `encajarSolicitudes`.
 *
 * Se dejan fuera las que ya no caben ni solas (ninguna mesa libre ni combinación les
 * sirve): están sobrevendidas, el encargado tiene que resolverlas a mano y no deben
 * bloquear el resto de horas del día.
 */
export function solicitudesSinMesa(
  intervalo: Intervalo,
  ocupacion: Ocupacion,
  margenMinutos: number,
  opcionesPara: (comensales: number) => readonly OpcionMesas[],
): Solicitud[] {
  return reservasSinMesaEncadenadas(intervalo, ocupacion.sinMesa, margenMinutos)
    .map(({ reserva, intervalo: iv }) => ({
      id: reserva.id,
      intervalo: iv,
      comensales: reserva.comensales,
      opciones: opcionesPara(reserva.comensales),
    }))
    .filter((s) =>
      s.opciones.some((o) =>
        o.mesaIds.every((id) => choquesDeMesa(ocupacion, id, s.intervalo, margenMinutos).length === 0),
      ),
    )
}
