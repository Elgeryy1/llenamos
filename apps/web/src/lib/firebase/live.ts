"use client"

/**
 * SOLO DEMO (emuladores): suscripciones en directo a Firestore (onSnapshot) para componentes de React.
 * En el VPS las lecturas en vivo van por `useLiveQuery` (`lib/api/live.ts`); `getFirebase()` falla en modo `postgres`.
 *
 * Cada gancho recibe una clave de texto que identifica lo que se escucha. Si la
 * clave cambia, se cancela la suscripción anterior y se abre otra; mientras llega
 * el primer dato, el estado es «loading». Con clave null no se escucha nada.
 */
import {
  doc,
  onSnapshot,
  type DocumentData,
  type Firestore,
  type Query,
  type SnapshotOptions,
} from "firebase/firestore"
import { useEffect, useEffectEvent, useState } from "react"
import { getFirebase } from "./client"

import type { Live } from "@/lib/api/live"
export type { Live }

const LOADING = { status: "loading" } as const

/** Las marcas de tiempo aún sin confirmar por el servidor llegan como estimación, no como null. */
const SNAPSHOT_OPTIONS: SnapshotOptions = { serverTimestamps: "estimate" }

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

/**
 * Un documento. parse recibe undefined si el documento no existe y decide qué
 * hacer (devolver un valor por defecto o lanzar un error).
 */
export function useLiveDoc<T>(path: string | null, parse: (id: string, data: DocumentData | undefined) => T): Live<T> {
  const [live, setState] = useKeyedState<T>(path)
  const read = useEffectEvent((id: string, data: DocumentData | undefined) => parse(id, data))

  useEffect(() => {
    if (path === null) return
    let unsubscribe = () => {}
    try {
      const { db } = getFirebase()
      unsubscribe = onSnapshot(
        doc(db, path),
        (snap) => setState(settle(path, () => read(snap.id, snap.exists() ? snap.data(SNAPSHOT_OPTIONS) : undefined))),
        (error) => setState({ key: path, live: { status: "error", error } }),
      )
    } catch (error) {
      // Firebase sin configurar: se avisa en la interfaz, no se oculta.
      queueMicrotask(() => setState({ key: path, live: { status: "error", error } }))
    }
    return () => unsubscribe()
  }, [path, setState])

  return live
}

/** Varios documentos a la vez (por ejemplo, los locales a los que alguien tiene acceso). */
export function useLiveDocs<T>(
  paths: readonly string[] | null,
  parse: (id: string, data: DocumentData | undefined) => T,
): Live<T[]> {
  const key = paths === null ? null : `docs:${paths.join("|")}`
  const [live, setState] = useKeyedState<T[]>(key)
  const read = useEffectEvent((id: string, data: DocumentData | undefined) => parse(id, data))

  useEffect(() => {
    if (key === null) return
    const list = key.slice("docs:".length).split("|").filter(Boolean)
    if (list.length === 0) {
      queueMicrotask(() => setState({ key, live: { status: "ready", data: [] } }))
      return
    }
    const received = new Map<string, DocumentData | undefined>()
    const unsubscribers: Array<() => void> = []
    try {
      const { db } = getFirebase()
      for (const path of list) {
        unsubscribers.push(
          onSnapshot(
            doc(db, path),
            (snap) => {
              received.set(path, snap.exists() ? snap.data(SNAPSHOT_OPTIONS) : undefined)
              if (received.size < list.length) return
              setState(
                settle(key, () =>
                  list.flatMap((p) => {
                    const data = received.get(p)
                    return data === undefined ? [] : [read(p.split("/").at(-1) ?? p, data)]
                  }),
                ),
              )
            },
            (error) => setState({ key, live: { status: "error", error } }),
          ),
        )
      }
    } catch (error) {
      queueMicrotask(() => setState({ key, live: { status: "error", error } }))
    }
    return () => unsubscribers.forEach((u) => u())
  }, [key, setState])

  return live
}

/**
 * Una consulta. La clave debe cambiar siempre que cambie la consulta
 * (ruta, filtros, orden o límite).
 */
export function useLiveQuery<T>(
  key: string | null,
  build: (db: Firestore) => Query,
  parse: (id: string, data: DocumentData) => T,
): Live<T[]> {
  const [live, setState] = useKeyedState<T[]>(key)
  const makeQuery = useEffectEvent((db: Firestore) => build(db))
  const read = useEffectEvent((id: string, data: DocumentData) => parse(id, data))

  useEffect(() => {
    if (key === null) return
    let unsubscribe = () => {}
    try {
      const { db } = getFirebase()
      unsubscribe = onSnapshot(
        makeQuery(db),
        (snap) => setState(settle(key, () => snap.docs.map((d) => read(d.id, d.data(SNAPSHOT_OPTIONS))))),
        (error) => setState({ key, live: { status: "error", error } }),
      )
    } catch (error) {
      queueMicrotask(() => setState({ key, live: { status: "error", error } }))
    }
    return () => unsubscribe()
  }, [key, setState])

  return live
}
