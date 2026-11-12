// Falla si código de producción arrastra los SDK de datos de Firebase por imports ESTÁTICOS, directos o transitivos.
// Un módulo está «contaminado» si importa de forma estática `firebase/firestore|functions|storage` o un módulo contaminado.
// Solo pueden estarlo los módulos de la demo (nombre con `demo`, `lib/firebase/{client,live,storage}`), y estos solo se
// cargan con `import()` y la guarda en línea de `lib/firebase/cargar-demo.ts`. Los `import type` no cuentan.
// Uso: `node scripts/check-imports.mjs`.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

const raizPorDefecto = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src")
const SDK = /^firebase\/(firestore|functions|storage)$/
const DEMO = /(^|\/)[^/]*demo[^/]*\.tsx?$|^lib\/firebase\/(client|live|storage)\.ts$/

function* fuentes(dir) {
  for (const nombre of readdirSync(dir)) {
    const ruta = path.join(dir, nombre)
    if (statSync(ruta).isDirectory()) yield* fuentes(ruta)
    else if (/\.tsx?$/.test(nombre) && !/\.test\.tsx?$/.test(nombre) && !nombre.endsWith(".d.ts")) yield ruta
  }
}

function resolver(raiz, desde, especificador) {
  const base = especificador.startsWith("@/") ? path.join(raiz, especificador.slice(2)) : especificador.startsWith(".") ? path.resolve(path.dirname(desde), especificador) : null
  if (!base) return null
  for (const candidato of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) if (existsSync(candidato)) return candidato
  return null
}

/** Especificadores de imports/exports estáticos que llegan al bundle (sin `import type`, con los de efecto lateral). */
export function importesEstaticosDe(fichero, texto = readFileSync(fichero, "utf8")) {
  const sf = ts.createSourceFile(fichero, texto, ts.ScriptTarget.Latest, true, /x$/.test(fichero) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  const salida = []
  for (const sentencia of sf.statements) {
    if (ts.isImportDeclaration(sentencia)) {
      const clausula = sentencia.importClause
      if (clausula?.isTypeOnly) continue
      const nombrados = clausula?.namedBindings
      // `import { type A } from "x"` sin valores se elimina al compilar; con algún valor sigue siendo un import real.
      if (nombrados && ts.isNamedImports(nombrados) && !clausula.name && nombrados.elements.length && nombrados.elements.every(e => e.isTypeOnly)) continue
      salida.push(sentencia.moduleSpecifier.text)
    } else if (ts.isExportDeclaration(sentencia) && sentencia.moduleSpecifier && !sentencia.isTypeOnly) salida.push(sentencia.moduleSpecifier.text)
  }
  return salida
}

/** `[{ fichero, via }]`: ficheros de producción no demo que arrastran un SDK de datos, con el primer paso de la cadena. */
export function importesContaminados(raiz = raizPorDefecto) {
  const ficheros = [...fuentes(raiz)]
  const relativa = f => path.relative(raiz, f).split(path.sep).join("/")
  const aristas = new Map(), directos = new Map()
  for (const f of ficheros) {
    const destinos = []
    for (const especificador of importesEstaticosDe(f)) {
      if (SDK.test(especificador)) directos.set(f, especificador)
      else { const destino = resolver(raiz, f, especificador); if (destino) destinos.push(destino) }
    }
    aristas.set(f, destinos)
  }
  const contaminados = new Map([...directos].map(([f, sdk]) => [f, sdk]))
  for (let cambio = true; cambio;) {
    cambio = false
    for (const [f, destinos] of aristas) {
      if (contaminados.has(f)) continue
      const origen = destinos.find(d => contaminados.has(d))
      if (origen) { contaminados.set(f, relativa(origen)); cambio = true }
    }
  }
  return [...contaminados].filter(([f]) => !DEMO.test(relativa(f))).map(([f, via]) => ({ fichero: relativa(f), via })).sort((a, b) => a.fichero.localeCompare(b.fichero))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lista = importesContaminados()
  if (lista.length) {
    console.error(`${lista.length} ficheros de producción arrastran un SDK de datos de Firebase por imports estáticos:`)
    for (const { fichero, via } of lista) console.error(`  ${fichero} (por ${via})`)
    process.exit(1)
  }
  console.log("Sin imports estáticos, directos ni transitivos, de firebase/firestore, firebase/functions ni firebase/storage fuera de la demo.")
}
