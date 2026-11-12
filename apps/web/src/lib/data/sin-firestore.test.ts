import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import ts from "typescript"
import { describe, expect, it } from "vitest"

/**
 * El bundle de producción (`NEXT_PUBLIC_DATA_BACKEND=postgres`) no puede contener Firestore, Functions ni Storage.
 * Se recorre el cierre de imports ESTÁTICOS de los archivos del terreno de reservas con el compilador de TypeScript
 * (imports de varias líneas, `import "x"`, `export … from`, `import x = require()`), saltando solo los que son de tipos.
 * Los `import()` dinámicos no cuentan: son la forma de cargar la demo. La compilación real con `postgres` se comprobó
 * aparte (ver el informe de W1); esta prueba evita que vuelva a colarse un import estático.
 */
const SRC = join(__dirname, "..", "..")

const PROHIBIDOS_EXTERNOS = /^firebase\/(firestore|functions|storage)$/
const PROHIBIDOS_LOCALES = [
  "lib/firebase/live", "lib/firebase/client", "lib/firebase/storage", "lib/firebase/demo-data",
  "lib/data/demo-firestore", "lib/data/demo-escrituras", "components/panel/PanelDataDemo",
]

/** Archivos del terreno de W1 que se ofrecen en VPS (cada uno debe existir: si se renombra, la prueba falla). */
const TERRENO = [
  "lib/data/backend.ts", "lib/data/hooks.ts", "lib/data/reservas.ts", "lib/data/clientes.ts", "lib/data/callables.ts", "lib/data/functions.ts",
  "lib/data/demo-live.ts", "lib/data/demo-carga.ts", "lib/plano/guardar.ts", "lib/config/hooks.ts",
  "components/panel/PanelData.tsx", "components/panel/PanelNoAccess.tsx", "components/proveedores/ProveedoresRestaurante.tsx",
  "lib/proveedores/api.ts", "lib/proveedores/campos.ts", "lib/publica/servidor.ts", "lib/publica/restaurante.ts", "lib/publica/callables.ts",
]

function resolver(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/") ? join(SRC, specifier.slice(2)) : specifier.startsWith(".") ? join(dirname(from), specifier) : null
  if (!base) return null
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

/** Especificadores de imports estáticos que llegan al bundle. */
export function importsEstaticos(file: string, source = readFileSync(file, "utf8")): string[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const found: string[] = []
  for (const node of sf.statements) {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause
      if (clause?.isTypeOnly) continue
      const named = clause?.namedBindings
      const soloTipos = clause && !clause.name && named && ts.isNamedImports(named) && named.elements.length > 0 && named.elements.every((e) => e.isTypeOnly)
      if (soloTipos) continue
      found.push(node.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier) && !node.isTypeOnly) {
      found.push(node.moduleSpecifier.text)
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) {
      found.push(node.moduleReference.expression.text)
    }
  }
  return found
}

/** Camino de imports estáticos desde `entry` hasta algo prohibido, o null si no hay. */
export function caminoProhibido(entry: string, leer: (file: string) => string = (f) => readFileSync(f, "utf8")): string[] | null {
  const visited = new Set<string>()
  const walk = (file: string, trail: string[]): string[] | null => {
    if (visited.has(file)) return null
    visited.add(file)
    for (const specifier of importsEstaticos(file, leer(file))) {
      if (PROHIBIDOS_EXTERNOS.test(specifier)) return [...trail, specifier]
      const target = resolver(file, specifier)
      if (!target) continue
      const relative = target.slice(SRC.length + 1).replace(/\.(tsx?)$/, "")
      if (PROHIBIDOS_LOCALES.some((p) => relative === p || relative.startsWith(`${p}/`))) return [...trail, relative]
      const hit = walk(target, [...trail, relative])
      if (hit) return hit
    }
    return null
  }
  return walk(entry, [entry.slice(SRC.length + 1)])
}

describe("detector de imports estáticos", () => {
  it("ve imports de varias líneas, efectos laterales y reexportaciones; ignora tipos y dinámicos", () => {
    const source = [
      'import {\n  doc,\n  type Firestore,\n} from "firebase/firestore"',
      'import "firebase/storage"',
      'export { x } from "firebase/functions"',
      'import type { A } from "firebase/firestore"',
      'import { type B, type C } from "firebase/firestore"',
      'const l = () => import("firebase/firestore")',
    ].join("\n")
    expect(importsEstaticos("x.ts", source)).toEqual(["firebase/firestore", "firebase/storage", "firebase/functions"])
  })

  it("sigue los imports transitivos hasta un módulo prohibido", () => {
    const leer = (f: string) => (f.endsWith("data/backend.ts") ? 'import "./demo-live"' : f.endsWith("data/demo-live.ts") ? 'import "firebase/storage"' : "")
    expect(caminoProhibido(join(SRC, "lib/data/backend.ts"), leer)).toEqual(["lib/data/backend.ts", "lib/data/demo-live", "firebase/storage"])
    expect(caminoProhibido(join(SRC, "lib/data/backend.ts"), () => 'import { x } from "./demo-firestore"')).toEqual(["lib/data/backend.ts", "lib/data/demo-firestore"])
  })
})

describe("terreno de reservas sin SDK de datos en el bundle del VPS", () => {
  for (const file of TERRENO) {
    it(`${file} existe y no arrastra Firestore, Functions ni Storage por imports estáticos`, () => {
      const full = join(SRC, file)
      expect(existsSync(full), `${file} ya no existe: actualiza la lista del terreno`).toBe(true)
      expect(caminoProhibido(full)).toBeNull()
    })
  }

  it("los módulos de la demo solo se cargan con import() desde un único sitio", () => {
    const quien = (modulo: string) => {
      const found: string[] = []
      const visit = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const full = join(dir, name)
          if (statSync(full).isDirectory()) { if (name !== "node_modules") visit(full) }
          else if (/\.tsx?$/.test(name) && !/\.test\./.test(name) && importsEstaticos(full).some((s) => resolver(full, s)?.includes(modulo))) found.push(full.slice(SRC.length + 1))
        }
      }
      visit(SRC)
      return found
    }
    for (const modulo of ["lib/data/demo-firestore", "lib/data/demo-escrituras", "components/panel/PanelDataDemo"]) {
      expect(quien(modulo), `${modulo} no puede importarse de forma estática`).toEqual([])
    }
  })

  it("la puerta de la demo lleva el literal del selector, que el empaquetador sustituye", () => {
    const carga = readFileSync(join(SRC, "lib/data/demo-carga.ts"), "utf8")
    expect(carga.match(/process\.env\.NEXT_PUBLIC_DATA_BACKEND === "postgres" \? SIN_DEMO\(\) : import\(/g)).toHaveLength(2)
    const panel = readFileSync(join(SRC, "components/panel/PanelData.tsx"), "utf8")
    expect(panel).toMatch(/process\.env\.NEXT_PUBLIC_DATA_BACKEND === "postgres"\s*\n?\s*\? \(\) => null\s*\n?\s*: dynamic\(/)
  })
})
