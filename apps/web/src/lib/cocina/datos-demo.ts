import { collection, query, where, type Firestore } from "firebase/firestore"
import type { StationKind } from "@llenamos/core"
import { ESTADOS_VISIBLES } from "./modelo"

/** Solo demo: se carga con `import()` dinámico desde la rama de emuladores, nunca en producción. */
export function consultaLineas(db: Firestore, base: string, stationId: string, kind: StationKind) {
  return query(collection(db, `${base}/orderLines`), where("stationId", "==", stationId), where("stationKind", "==", kind), where("status", "in", [...ESTADOS_VISIBLES]))
}
