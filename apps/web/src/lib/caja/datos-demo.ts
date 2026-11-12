"use client"

import { useEffect, useEffectEvent, useState } from "react"
import { z } from "zod"
import type { ConId, Lectura } from "./datos-tipos"
import type { Restriccion } from "./restricciones"
import { cargarClienteDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"

/**
 * El selector se sustituye al compilar: con `postgres` este valor es `null` y el empaquetador descarta los `import()`,
 * así que el paquete de producción no incluye ni siquiera como trozo diferido `firebase/firestore`.
 */
const cargarDemo = process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? null : () => Promise.all([cargarFirestore(), cargarClienteDemo()])

/**
 * Lectura de la demo con emuladores. Firestore se carga con `import()` aquí dentro y solo si este gancho recibe una
 * ruta, es decir, en la rama demo: el paquete de producción (`postgres`) pasa siempre `null` y no lo descarga.
 * La caché se puede leer, pero nunca autoriza un cobro o arqueo.
 */
export function useConsulta<T>(
  path: string | null,
  schema: z.ZodType<T>,
  constraints: Restriccion[] = [],
  suffix = "",
): Lectura<ConId<T>> {
  const key = `${path}:${suffix}`
  const [state, setState] = useState<{
    key: string
    value: Lectura<ConId<T>>
  } | null>(null)
  const read = useEffectEvent((data: unknown) => schema.parse(data))
  const build = useEffectEvent(() => constraints)
  useEffect(() => {
    if (!path) return
    let cancelled = false
    let unsubscribe = () => {}
    const fail = (error: unknown) => { if (!cancelled) setState({ key, value: { status: "error", error } }) }
    void (async () => {
      if (!cargarDemo) throw new Error("Las lecturas directas de Firestore solo existen en la demo con emuladores.")
      const [firestore, { getFirebase }] = await cargarDemo()
      if (cancelled) return
      const filters = build().map((c) => c.t === "where" ? firestore.where(c.campo, c.op as never, c.valor) : c.t === "orderBy" ? firestore.orderBy(c.campo, c.dir) : firestore.limit(c.n))
      unsubscribe = firestore.onSnapshot(
        firestore.query(firestore.collection(getFirebase().db, path), ...filters),
        { includeMetadataChanges: true },
        (snapshot) => {
          if (cancelled) return
          try {
            setState({
              key,
              value: {
                status: "ready",
                data: snapshot.docs.map((d) => ({ ...read(d.data()), id: d.id })),
                fresh: !snapshot.metadata.fromCache && !snapshot.metadata.hasPendingWrites,
              },
            })
          } catch {
            fail(new Error("Los datos guardados no coinciden con el contrato de caja. No se pueden usar para cobrar."))
          }
        },
        fail,
      )
    })().catch(fail)
    return () => { cancelled = true; unsubscribe() }
  }, [path, key])
  return state?.key === key ? state.value : { status: "loading" }
}
