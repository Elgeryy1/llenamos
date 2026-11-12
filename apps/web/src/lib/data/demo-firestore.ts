/**
 * Suscripciones a Firestore solo para la demo con emuladores. Este módulo importa el SDK de datos
 * y solo se carga con `import()` dentro de la rama demo (`demo-live.ts`): el bundle de producción
 * (`NEXT_PUBLIC_DATA_BACKEND=postgres`) no debe contenerlo.
 */
import {
  collection,
  doc,
  limit as limitTo,
  onSnapshot,
  orderBy as orderByField,
  query,
  Timestamp,
  where,
  type DocumentData,
  type Query,
  type SnapshotOptions,
  type WhereFilterOp,
} from "firebase/firestore"
import { getFirebase } from "@/lib/firebase/client"

/** Las marcas de tiempo aún sin confirmar por el servidor llegan como estimación, no como null. */
const SNAPSHOT_OPTIONS: SnapshotOptions = { serverTimestamps: "estimate" }

/** Consulta descrita con datos, para poder usarla como clave y construirla solo cuando se carga el SDK. */
export interface DemoQuerySpec {
  path: string
  where?: ReadonlyArray<readonly [field: string, op: WhereFilterOp, value: string | number | boolean | { ms: number }]>
  orderBy?: readonly [field: string, direction: "asc" | "desc"]
  limit?: number
}

export interface Emit<T> {
  data: (value: T) => void
  error: (error: unknown) => void
}

function build(spec: DemoQuerySpec): Query {
  const { db } = getFirebase()
  return query(
    collection(db, spec.path),
    ...(spec.where ?? []).map(([field, op, value]) => where(field, op, typeof value === "object" ? Timestamp.fromMillis(value.ms) : value)),
    ...(spec.orderBy ? [orderByField(spec.orderBy[0], spec.orderBy[1])] : []),
    ...(spec.limit ? [limitTo(spec.limit)] : []),
  )
}

function settle<T>(emit: Emit<T>, compute: () => T) {
  try {
    emit.data(compute())
  } catch (error) {
    emit.error(error)
  }
}

export function subscribeDoc<T>(path: string, parse: (id: string, data: DocumentData | undefined) => T, emit: Emit<T>): () => void {
  try {
    const { db } = getFirebase()
    return onSnapshot(
      doc(db, path),
      (snap) => settle(emit, () => parse(snap.id, snap.exists() ? snap.data(SNAPSHOT_OPTIONS) : undefined)),
      emit.error,
    )
  } catch (error) {
    emit.error(error)
    return () => {}
  }
}

export function subscribeQuery<T>(spec: DemoQuerySpec, parse: (id: string, data: DocumentData) => T, emit: Emit<T[]>): () => void {
  try {
    return onSnapshot(build(spec), (snap) => settle(emit, () => snap.docs.map((d) => parse(d.id, d.data(SNAPSHOT_OPTIONS)))), emit.error)
  } catch (error) {
    emit.error(error)
    return () => {}
  }
}

/** Varios documentos sueltos; los que no existen se omiten. Emite cuando ya ha llegado cada uno. */
export function subscribeDocs<T>(paths: readonly string[], parse: (id: string, data: DocumentData | undefined) => T, emit: Emit<T[]>): () => void {
  if (paths.length === 0) {
    emit.data([])
    return () => {}
  }
  const received = new Map<string, DocumentData | undefined>()
  const unsubscribers = paths.map((path) =>
    subscribeDoc<DocumentData | undefined>(
      path,
      (_id, data) => data,
      {
        data: (data) => {
          received.set(path, data)
          if (received.size < paths.length) return
          settle(emit, () =>
            paths.flatMap((p) => {
              const value = received.get(p)
              return value === undefined ? [] : [parse(p.split("/").at(-1) ?? p, value)]
            }),
          )
        },
        error: emit.error,
      },
    ),
  )
  return () => unsubscribers.forEach((u) => u())
}
