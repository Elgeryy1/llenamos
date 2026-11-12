// @vitest-environment node
import { createRequire } from "node:module"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { buscarSdkDeDatos } from "../../scripts/bundle-scan.mjs"
import { importesContaminados } from "../../scripts/check-imports.mjs"

const temporales: string[] = []
function carpeta(ficheros: Record<string, string>) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "bundle-"))
  temporales.push(dir)
  for (const [nombre, texto] of Object.entries(ficheros)) {
    mkdirSync(path.dirname(path.join(dir, nombre)), { recursive: true })
    writeFileSync(path.join(dir, nombre), texto)
  }
  return dir
}
afterEach(() => { for (const dir of temporales.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe("comprobación del bundle de producción", () => {
  it("los paquetes reales de Auth y de la app no contienen ningún marcador (el escáner no da falsos positivos)", () => {
    const requerir = createRequire(createRequire(import.meta.url).resolve("firebase/package.json"))
    const dist = (paquete: string) => path.join(path.dirname(requerir.resolve(`${paquete}/package.json`)), "dist")
    expect(buscarSdkDeDatos(dist("@firebase/auth"), dist("@firebase/app"))).toEqual([])
  })
  it("los paquetes reales de Firestore, Functions y Storage sí los activan", () => {
    const requerir = createRequire(createRequire(import.meta.url).resolve("firebase/package.json"))
    const dist = (paquete: string) => path.join(path.dirname(requerir.resolve(`${paquete}/package.json`)), "dist")
    const sdk = buscarSdkDeDatos(dist("@firebase/firestore"), dist("@firebase/functions"), dist("@firebase/storage")).map((h: { sdk: string }) => h.sdk)
    expect([...new Set(sdk)].sort()).toEqual(["firebase/firestore", "firebase/functions", "firebase/storage"])
  })
  it("el registro de componentes de @firebase/app no cuenta como SDK de datos", () => {
    const dir = carpeta({ "static/app.js": "{'@firebase/firestore':'fire-fst','@firebase/functions':'fire-fn','@firebase/storage':'fire-gcs'}" })
    expect(buscarSdkDeDatos(dir)).toEqual([])
  })
  it("detecta Firestore, Functions y Storage", () => {
    const dir = carpeta({
      "static/f.js": "const h='firestore.googleapis.com'",
      "server/g.js": "const h='https://europe-west1-x.cloudfunctions.net'",
      "static/s.js": "const h='firebasestorage.googleapis.com'",
    })
    expect(buscarSdkDeDatos(dir).map((h: { sdk: string }) => h.sdk).sort()).toEqual(["firebase/firestore", "firebase/functions", "firebase/storage"])
  })
  it("ignora mapas de fuentes", () => {
    const dir = carpeta({ "static/a.js.map": "firestore.googleapis.com" })
    expect(buscarSdkDeDatos(dir)).toEqual([])
  })
})

describe("imports estáticos de los SDK de datos", () => {
  const nombres = (dir: string) => importesContaminados(dir).map((h: { fichero: string }) => h.fichero)
  it("marca el import directo, el de efecto lateral y el que llega por un módulo intermedio", () => {
    const dir = carpeta({
      "lib/directo.ts": `import { collection } from "firebase/firestore"\nexport const x = collection`,
      "lib/lateral.ts": `import "firebase/functions"`,
      "lib/reexporta.ts": `export { getStorage } from "firebase/storage"`,
      "lib/intermedio.ts": `import { x } from "./directo"\nexport const y = x`,
      "lib/pantalla.ts": `import { y } from "./intermedio"\nexport const z = y`,
    })
    expect(nombres(dir)).toEqual(["lib/directo.ts", "lib/intermedio.ts", "lib/lateral.ts", "lib/pantalla.ts", "lib/reexporta.ts"])
  })
  it("marca a quien importa de forma estática lib/firebase/client, que arrastra Firestore", () => {
    const dir = carpeta({
      "lib/firebase/demo-data.ts": `import { getFirestore } from "firebase/firestore"\nexport { getFirestore }`,
      "lib/firebase/client.ts": `import { getFirestore } from "./demo-data"\nexport const getFirebase = getFirestore`,
      "components/Mala.tsx": `import { getFirebase } from "@/lib/firebase/client"\nexport const M = getFirebase`,
    })
    expect(nombres(dir)).toEqual(["components/Mala.tsx"])
  })
  it("deja pasar tipos (también de varias líneas y sin punto y coma), import() y módulos de la demo", () => {
    const dir = carpeta({
      "lib/tipos.ts": `import type {\n  Firestore,\n  Query\n} from "firebase/firestore"\nimport { type DocumentData } from "firebase/firestore"\nexport type X = Firestore | Query | DocumentData`,
      "lib/dinamico.ts": `export const cargar = () => import("firebase/functions")`,
      "lib/caja-demo.ts": `import { onSnapshot } from "firebase/firestore"\nexport { onSnapshot }`,
      "lib/usa-demo.ts": `export const cargar = () => import("./caja-demo")`,
    })
    expect(nombres(dir)).toEqual([])
  })
})
