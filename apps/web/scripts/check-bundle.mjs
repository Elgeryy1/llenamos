// Construye la web como producción en VPS (`postgres`) y falla si el resultado contiene Firestore, Functions o Storage.
// Uso: `pnpm --filter web check:bundle`. Construye en `.next-bundle-check` para no pisar `.next`.
import { spawnSync } from "node:child_process"
import { existsSync, rmSync } from "node:fs"
import path from "node:path"
import { buscarSdkDeDatos } from "./bundle-scan.mjs"

// `--dir .next --sin-construir` revisa una salida ya construida (la usa el Dockerfile tras `next build`).
const dirArg = process.argv.indexOf("--dir")
const distDir = dirArg > 0 ? process.argv[dirArg + 1] : ".next-bundle-check"
const env = {
  ...process.env,
  NEXT_DIST_DIR: distDir,
  NEXT_PUBLIC_DATA_BACKEND: "postgres",
  NEXT_PUBLIC_USE_EMULATORS: "0",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: "llenamos-logiqd",
  NEXT_PUBLIC_FIREBASE_API_KEY: "clave-publica-de-prueba",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "llenamos-logiqd.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:0:web:0",
  NEXT_PUBLIC_SITE_URL: "https://app-llenamos.logiqd.me",
  NEXT_TELEMETRY_DISABLED: "1",
}
if (!process.argv.includes("--sin-construir")) {
  // Con `--dir` la carpeta es de otro (p. ej. `.next`): se usa tal cual y nunca se borra.
  if (dirArg < 0) rmSync(distDir, { recursive: true, force: true })
  const build = spawnSync("npx", ["next", "build"], { env, stdio: "inherit" })
  if (build.status !== 0) { console.error("La construcción ha fallado."); if (dirArg < 0) rmSync(distDir, { recursive: true, force: true }); process.exit(build.status ?? 1) }
}
const carpetas = ["static", "server"].map(c => path.join(distDir, c)).filter(existsSync)
const limpiar = () => { if (dirArg < 0) rmSync(distDir, { recursive: true, force: true }) }
if (!carpetas.length) { console.error(`No hay salida de build en ${distDir}.`); limpiar(); process.exit(1) }
const hallazgos = buscarSdkDeDatos(...carpetas)
if (hallazgos.length) {
  console.error("El bundle de producción (postgres) contiene SDK de datos de Firebase:")
  for (const h of hallazgos.slice(0, 40)) console.error(`  ${h.sdk} (${h.marcador}) en ${h.fichero}`)
  if (hallazgos.length > 40) console.error(`  … y ${hallazgos.length - 40} más`)
  limpiar()
  process.exit(1)
}
limpiar()
console.log("Bundle limpio: sin firebase/firestore, firebase/functions ni firebase/storage.")
