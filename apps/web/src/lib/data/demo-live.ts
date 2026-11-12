"use client"

/**
 * Lecturas en directo de la demo (emuladores de Firebase) sin importar el SDK de datos de forma
 * estática. El código de Firestore vive en `demo-firestore.ts` y se pide con `import()` solo cuando
 * hay algo que escuchar; con `NEXT_PUBLIC_DATA_BACKEND=postgres` las claves son null y no se carga nunca.
 */
import type { DocumentData } from "firebase/firestore"
import { useEffect, useEffectEvent, useState } from "react"
import type { Live } from "@/lib/api/live"
import { cargarDemoLecturas } from "./demo-carga"
import type { DemoQuerySpec, Emit } from "./demo-firestore"

export type { DemoQuerySpec }

const LOADING = { status: "loading" } as const
type Keyed<T> = { key: string | null; live: Live<T> }

/** Abre una suscripción (tras cargar el SDK) y estabiliza el resultado por clave. */
function useDemoSubscription<T, D>(
  key: string | null,
  parse: (id: string, data: D) => unknown,
  open: (emit: Emit<T>, parse: (id: string, data: D) => unknown) => Promise<() => void>,
): Live<T> {
  const [state, setState] = useState<Keyed<T>>({ key: null, live: LOADING })
  const read = useEffectEvent((id: string, data: D) => parse(id, data))
  const start = useEffectEvent(open)

  useEffect(() => {
    if (key === null) return
    let closed = false
    let unsubscribe = () => {}
    const emit: Emit<T> = {
      data: (data) => { if (!closed) setState({ key, live: { status: "ready", data } }) },
      error: (error) => { if (!closed) setState({ key, live: { status: "error", error } }) },
    }
    start(emit, (id, data) => read(id, data)).then(
      (stop) => { if (closed) stop(); else unsubscribe = stop },
      emit.error,
    )
    return () => { closed = true; unsubscribe() }
  }, [key])

  return key !== null && state.key === key ? state.live : LOADING
}

/** Un documento. `parse` recibe undefined si no existe. */
export function useDemoDoc<T>(path: string | null, parse: (id: string, data: DocumentData | undefined) => T): Live<T> {
  return useDemoSubscription<T, DocumentData | undefined>(path === null ? null : `doc:${path}`, parse, async (emit, read) => (await cargarDemoLecturas()).subscribeDoc(path!, read as typeof parse, emit))
}

/** Varios documentos a la vez. */
export function useDemoDocs<T>(paths: readonly string[] | null, parse: (id: string, data: DocumentData | undefined) => T): Live<T[]> {
  return useDemoSubscription<T[], DocumentData | undefined>(paths === null ? null : `docs:${paths.join("|")}`, parse, async (emit, read) => (await cargarDemoLecturas()).subscribeDocs(paths!, read as typeof parse, emit))
}

/** Una consulta descrita con datos; la clave sale de la propia descripción. */
export function useDemoQuery<T>(spec: DemoQuerySpec | null, parse: (id: string, data: DocumentData) => T): Live<T[]> {
  return useDemoSubscription<T[], DocumentData>(spec === null ? null : `query:${JSON.stringify(spec)}`, parse, async (emit, read) => (await cargarDemoLecturas()).subscribeQuery(spec!, read as typeof parse, emit))
}
