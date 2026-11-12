/**
 * Puerta única a los módulos de la demo que importan el SDK de datos de Firebase. La condición va escrita con el
 * literal `process.env.NEXT_PUBLIC_DATA_BACKEND` en el mismo sitio del `import()`: el empaquetador lo sustituye al
 * compilar y descarta la rama, así que con `postgres` ni siquiera se generan los trozos asíncronos con Firestore.
 */
const SIN_DEMO = () => Promise.reject(new Error("La demo con emuladores no existe en el servidor propio."))

export const cargarDemoLecturas = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("./demo-firestore"))
export const cargarDemoEscrituras = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? SIN_DEMO() : import("./demo-escrituras"))
