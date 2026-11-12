// Busca restos de los SDK de datos de Firebase en una salida de `next build`.
// Los marcadores son cadenas que solo existen dentro de cada SDK (hosts de producción de los servicios y sus clases de error). No sirven los nombres `@firebase/*`: `@firebase/app` los lista todos.
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"

export const MARCADORES = {
  "firebase/firestore": ["firestore.googleapis.com", "FirestoreError"],
  "firebase/functions": [".cloudfunctions.net", "FunctionsError"],
  "firebase/storage": ["firebasestorage.googleapis.com", "StorageError"],
}
const EXTENSIONES = new Set([".js", ".mjs", ".cjs", ".html", ".rsc", ".json"])

function* ficheros(dir) {
  for (const nombre of readdirSync(dir)) {
    const ruta = path.join(dir, nombre)
    const info = statSync(ruta)
    if (info.isDirectory()) yield* ficheros(ruta)
    else if (EXTENSIONES.has(path.extname(nombre))) yield ruta
  }
}

/** Devuelve `[{ sdk, marcador, fichero }]`; vacío si la salida está limpia. */
export function buscarSdkDeDatos(...carpetas) {
  const hallazgos = []
  for (const carpeta of carpetas) {
    for (const fichero of ficheros(carpeta)) {
      // Los mapas de fuentes y los manifiestos de build repiten rutas de paquetes sin cargarlos.
      if (/\.(map)$/.test(fichero) || /(build|react-loadable|app-paths|server-reference)-manifest|\/trace$/.test(fichero)) continue
      const texto = readFileSync(fichero, "utf8")
      for (const [sdk, marcadores] of Object.entries(MARCADORES)) {
        const marcador = marcadores.find(m => texto.includes(m))
        if (marcador) hallazgos.push({ sdk, marcador, fichero: path.relative(process.cwd(), fichero) })
      }
    }
  }
  return hallazgos
}
