/**
 * Única puerta de los SDK de datos de Firebase y de su cliente. Solo la rama demo (emuladores) los carga.
 * La guarda se escribe en línea con `process.env.NEXT_PUBLIC_DATA_BACKEND`, que Next sustituye al compilar: con
 * `postgres` la rama muere y el bundler no emite ningún chunk de Firestore, Functions ni Storage
 * (`pnpm --filter web check:bundle` lo comprueba). No muevas la comparación a una función: dejaría de eliminarse.
 */
const SIN_DEMO = () => Promise.reject(new Error("Los datos de demostración no existen en el servidor del VPS."))

export const cargarFirestore = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("firebase/firestore"))
export const cargarFunctions = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("firebase/functions"))
export const cargarStorage = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("firebase/storage"))
export const cargarClienteDemo = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("./client"))
export const cargarStorageDemo = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("./storage"))
export const cargarCocinaDemo = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("@/lib/cocina/datos-demo"))
