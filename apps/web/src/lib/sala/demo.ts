"use client"
/**
 * Lecturas de la demo (emuladores) para sala, cocina y carta. Firestore solo se carga con `import()` dentro del
 * efecto: en producción (`NEXT_PUBLIC_DATA_BACKEND=postgres`) estos ganchos nunca se montan con una clave, así que
 * el SDK no se descarga. Misma forma que `Live<T>` del resto de lecturas.
 */
import { useEffect, useState } from "react"
import type { Live } from "@/lib/api/live"
import { cargarClienteDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"

export type Condicion = readonly [campo: string, operador: "==" | "in", valor: unknown]
type Keyed<T> = { key: string; live: Live<T> }

function useClaveada<T>(key: string | null) {
  const [state, setState] = useState<Keyed<T> | null>(null)
  const live: Live<T> = key !== null && state?.key === key ? state.live : { status: "loading" }
  return [live, setState] as const
}
function resolver<T>(key: string, calcular: () => T): Keyed<T> {
  try { return { key, live: { status: "ready", data: calcular() } } }
  catch (error) { return { key, live: { status: "error", error } } }
}

/** Un documento. `parse` recibe `undefined` si no existe. */
export function useDemoDoc<T>(path: string | null, parse: (id: string, data: Record<string, unknown> | undefined) => T): Live<T> {
  const [live, setState] = useClaveada<T>(path)
  useEffect(() => {
    if (path === null) return
    let activo = true, parar = () => {}
    void Promise.all([cargarFirestore(), cargarClienteDemo()]).then(([{ doc, onSnapshot }, { getFirebase }]) => {
      if (!activo) return
      parar = onSnapshot(doc(getFirebase().db, path),
        snap => setState(resolver(path, () => parse(snap.id, snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : undefined))),
        error => setState({ key: path, live: { status: "error", error } }))
    }).catch(error => { if (activo) setState({ key: path, live: { status: "error", error } }) })
    return () => { activo = false; parar() }
  }, [path]) // eslint-disable-line react-hooks/exhaustive-deps
  return live
}

/** Una colección con filtros de igualdad o pertenencia. La clave cambia con la ruta y los filtros. */
export function useDemoQuery<T>(path: string | null, condiciones: readonly Condicion[], parse: (id: string, data: Record<string, unknown>) => T): Live<T[]> {
  const key = path === null ? null : JSON.stringify([path, condiciones])
  const [live, setState] = useClaveada<T[]>(key)
  useEffect(() => {
    if (key === null || path === null) return
    let activo = true, parar = () => {}
    void Promise.all([cargarFirestore(), cargarClienteDemo()]).then(([{ collection, onSnapshot, query, where }, { getFirebase }]) => {
      if (!activo) return
      const consulta = query(collection(getFirebase().db, path), ...condiciones.map(([campo, operador, valor]) => where(campo, operador, valor)))
      parar = onSnapshot(consulta,
        snap => setState(resolver(key, () => snap.docs.map(d => parse(d.id, d.data({ serverTimestamps: "estimate" }))))),
        error => setState({ key, live: { status: "error", error } }))
    }).catch(error => { if (activo) setState({ key, live: { status: "error", error } }) })
    return () => { activo = false; parar() }
  }, [key]) // eslint-disable-line react-hooks/exhaustive-deps
  return live
}
