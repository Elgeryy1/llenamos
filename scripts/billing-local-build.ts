import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs'

// Solo artefactos locales e ignorados. No modifica el índice compartido ni firebase.json.
const root = new URL('../', import.meta.url)
const config = JSON.parse(readFileSync(new URL('firebase.json', root), 'utf8'))
config.emulators = { ...config.emulators, auth: { port: 9105 }, firestore: { port: 8099 }, functions: { port: 5015 }, storage: { port: 9215 }, ui: { enabled: true, port: 4014 }, hub: { port: 4414 }, logging: { port: 4514 }, eventarc: { port: 9314 }, tasks: { port: 9514 } }
writeFileSync(new URL('firebase.agente4.json', root), `${JSON.stringify(config, null, 2)}\n`)
const env = readFileSync(new URL('apps/web/.env.example', root), 'utf8')
writeFileSync(new URL('apps/web/.env.local', root), `${env}\nNEXT_PUBLIC_AUTH_EMULATOR_PORT=9105\nNEXT_PUBLIC_FIRESTORE_EMULATOR_PORT=8099\nNEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT=5015\nNEXT_PUBLIC_STORAGE_EMULATOR_PORT=9215\nNEXT_PUBLIC_SITE_URL=http://127.0.0.1:3014\n`)
execFileSync('pnpm', ['--filter','functions','exec','tsup','--config','src/fase6-billing/tsup.local.ts'], { cwd: root, stdio: 'inherit' })
copyFileSync(new URL('functions/lib/emulator-entry.js', root), new URL('functions/lib/index.js', root))
console.log('Entrada local preparada. Arranca los emuladores con firebase.agente4.json.')
