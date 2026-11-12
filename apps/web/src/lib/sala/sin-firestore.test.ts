import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

/**
 * El bundle de producción (`NEXT_PUBLIC_DATA_BACKEND=postgres`) no puede traer Firestore, Functions ni Storage. En el
 * terreno de sala, cocina, carta y avisos solo la rama demo los usa, siempre con `import()` dinámico.
 * Mira solo los imports directos de cada archivo: lo que llega por transitividad (`lib/data/*`, `lib/inventario/*`, `lib/firebase/*`,
 * de otros agentes) lo cubre la prueba del bundle de producción de W5.
 */
const raiz = path.resolve(__dirname, "../..")
const carpetas = ["lib/comandero", "lib/cocina", "lib/carta", "lib/sala", "lib/mesa-publica", "lib/para-llevar-publico", "components/comandero", "components/cocina", "components/carta", "components/avisos", "components/sala", "components/tareas", "components/mesa-publica"]
const PROHIBIDO = /\bfrom\s+["'](?:firebase\/(?:firestore|functions|storage)|@\/lib\/firebase\/(?:live|storage|client|demo-data))["']/
/** Las importaciones solo de tipos desaparecen al compilar. */
const sinTipos = (texto: string) => texto.replace(/^\s*import type\b[^;]*?from\s+["'][^"']+["']/gm, "")
// Módulos que existen solo para la demo y que solo se importan de forma dinámica.
const SOLO_DEMO = new Set(["lib/cocina/datos-demo.ts"])

function archivos(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? archivos(full) : /\.(ts|tsx)$/.test(name) && !/\.test\./.test(name) ? [full] : []
  })
}

describe("los archivos de sala, cocina y carta no importan Firebase de datos de forma directa y estática", () => {
  const todos = carpetas.flatMap(c => archivos(path.join(raiz, c)))
  it("revisa los archivos del terreno", () => expect(todos.length).toBeGreaterThan(40))
  it.each(todos.map(f => [path.relative(raiz, f), f]))("%s", (relativo, file) => {
    if (SOLO_DEMO.has(relativo)) return
    const texto = sinTipos(readFileSync(file, "utf8"))
    expect(PROHIBIDO.test(texto), "importa Firebase de datos de forma estática").toBe(false)
    // Los módulos solo demo nadie los importa de forma estática.
    for (const solo of SOLO_DEMO) expect(texto).not.toMatch(new RegExp(`^\\s*import[^\\n]*from\\s+["'][^"']*${path.basename(solo, ".ts")}["']`, "m"))
  })
})
