import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// El paquete de producción no puede traer Firestore, Functions ni Storage por estas carpetas: solo la rama demo los carga con import().
const RAIZ = join(__dirname, "..")
const MODULOS = ["personal", "inventario", "compras", "analisis", "campanas", "fidelizacion"]
const CARPETAS = [...MODULOS.map((c) => join(RAIZ, c)), join(RAIZ, "fase4"), ...MODULOS.map((c) => join(RAIZ, "..", "components", c))]
const PROHIBIDOS = String.raw`firebase\/(?:firestore|functions|storage)|@\/lib\/firebase\/(?:live|storage|demo-data|client)`
// Imports con nombres (en una o varias líneas), de efecto (`import "x"`) y reexportaciones; los `import type` no cargan nada.
const PROHIBIDO = new RegExp(String.raw`(?:^|\n)\s*(?:(?:import|export)\s+(?!type\b)[^;"']*?from\s+|import\s+)["'](?:${PROHIBIDOS})["']`)

function fuentes(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) return fuentes(p)
    return /\.(ts|tsx)$/.test(n) && !/\.test\.|fixtures|capturas/.test(n) ? [p] : []
  })
}

describe("terreno de gestión sin Firebase de datos", () => {
  it("la comprobación detecta las formas habituales de import", () => {
    for (const malo of ['import { collection } from "firebase/firestore"', 'import {\n  collection,\n  query,\n} from "firebase/firestore"', 'import "firebase/firestore"', 'import { getFirebase } from "@/lib/firebase/client"', 'export * from "firebase/storage"'])
      expect(PROHIBIDO.test(`\n${malo}\n`), malo).toBe(true)
    for (const bueno of ['import type { Firestore } from "firebase/firestore"', 'import { useLiveQuery } from "@/lib/api/live"', 'const x = await import("firebase/firestore")'])
      expect(PROHIBIDO.test(`\n${bueno}\n`), bueno).toBe(false)
  })

  it("ningún archivo importa Firestore, Functions o Storage de forma estática", () => {
    const malos = CARPETAS.flatMap(fuentes).filter((f) => PROHIBIDO.test(readFileSync(f, "utf8")))
    expect(malos).toEqual([])
  })
})
