"use client"

/**
 * Escucha de Firestore solo para la demo con emuladores. El SDK se carga con `import()` dentro del efecto, así que
 * el paquete de producción (`NEXT_PUBLIC_DATA_BACKEND=postgres`) no lo contiene: en el VPS estas lecturas se llaman
 * con clave nula y no hacen nada. Los constructores de consultas reciben el módulo ya cargado (`fs`).
 */
import type { DocumentData, Firestore, Query } from "firebase/firestore"
import { useEffect, useEffectEvent, useState } from "react"
import type { Live } from "@/lib/api/live"
import { cargarClienteDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"
export type { Live }

export type FirestoreModulo = typeof import("firebase/firestore")

const LOADING = { status: "loading" } as const
type Keyed<T> = { key: string | null; live: Live<T> }

function useKeyedState<T>(key: string | null) {
  const [state, setState] = useState<Keyed<T>>({ key: null, live: LOADING })
  const live: Live<T> = key !== null && state.key === key ? state.live : LOADING
  return [live, setState] as const
}

function settle<T>(key: string, compute: () => T): Keyed<T> {
  try {
    return { key, live: { status: "ready", data: compute() } }
  } catch (error) {
    return { key, live: { status: "error", error } }
  }
}

async function cargar() {
  const [fs, cliente] = await Promise.all([cargarFirestore(), cargarClienteDemo()])
  return { fs, db: cliente.getFirebase().db }
}

/** Un documento; `parse` recibe undefined si no existe. Con ruta nula no escucha nada. */
export function useLiveDoc<T>(path: string | null, parse: (id: string, data: DocumentData | undefined) => T): Live<T> {
  const [live, setState] = useKeyedState<T>(path)
  const read = useEffectEvent((id: string, data: DocumentData | undefined) => parse(id, data))
  useEffect(() => {
    if (path === null) return
    let vivo = true
    let unsubscribe = () => {}
    cargar().then(
      ({ fs, db }) => {
        if (!vivo) return
        unsubscribe = fs.onSnapshot(
          fs.doc(db, path),
          (snap) => setState(settle(path, () => read(snap.id, snap.exists() ? snap.data({ serverTimestamps: "estimate" }) : undefined))),
          (error) => setState({ key: path, live: { status: "error", error } }),
        )
      },
      (error: unknown) => { if (vivo) setState({ key: path, live: { status: "error", error } }) },
    )
    return () => { vivo = false; unsubscribe() }
  }, [path, setState])
  return live
}

/** Una consulta. La clave debe cambiar siempre que cambie la consulta (ruta, filtros, orden o límite). */
export function useLiveQuery<T>(key: string | null, build: (db: Firestore, fs: FirestoreModulo) => Query, parse: (id: string, data: DocumentData) => T): Live<T[]> {
  const [live, setState] = useKeyedState<T[]>(key)
  const makeQuery = useEffectEvent((db: Firestore, fs: FirestoreModulo) => build(db, fs))
  const read = useEffectEvent((id: string, data: DocumentData) => parse(id, data))
  useEffect(() => {
    if (key === null) return
    let vivo = true
    let unsubscribe = () => {}
    cargar().then(
      ({ fs, db }) => {
        if (!vivo) return
        unsubscribe = fs.onSnapshot(
          makeQuery(db, fs),
          (snap) => setState(settle(key, () => snap.docs.map((d) => read(d.id, d.data({ serverTimestamps: "estimate" }))))),
          (error) => setState({ key, live: { status: "error", error } }),
        )
      },
      (error: unknown) => { if (vivo) setState({ key, live: { status: "error", error } }) },
    )
    return () => { vivo = false; unsubscribe() }
  }, [key, setState])
  return live
}
