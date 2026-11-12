/**
 * Filtros de las lecturas de la demo, como datos puros. Se traducen a Firestore dentro de `datos-demo.ts`, que carga
 * `firebase/firestore` con `import()` solo en la rama demo: este archivo no importa nada de Firebase.
 */
export type Restriccion =
  | { t: "where"; campo: string; op: string; valor: unknown }
  | { t: "orderBy"; campo: string; dir: "asc" | "desc" }
  | { t: "limit"; n: number }
export const donde = (campo: string, op: string, valor: unknown): Restriccion => ({ t: "where", campo, op, valor })
export const ordenar = (campo: string, dir: "asc" | "desc" = "asc"): Restriccion => ({ t: "orderBy", campo, dir })
export const limite = (n: number): Restriccion => ({ t: "limit", n })
