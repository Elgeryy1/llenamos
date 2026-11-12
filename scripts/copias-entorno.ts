/** Lanzador local: custodia de prueba fuera del repositorio y puertos exclusivos de la fila 1. */
import { existsSync,readFileSync,writeFileSync,mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
const keyPath = '/tmp/llenamos-copias-key-v1'
if (!existsSync(keyPath)) writeFileSync(keyPath,randomBytes(32).toString('base64'),{ mode:0o600 })
mkdirSync('/tmp/copias-firebase-config',{ recursive:true })
const env = { ...process.env,XDG_CONFIG_HOME:'/tmp/copias-firebase-config',XDG_DATA_HOME:'/tmp/copias-pnpm',PNPM_HOME:'/tmp/copias-pnpm',FIREBASE_EMULATORS_PATH:'/home/gery/.cache/firebase/emulators',GCLOUD_PROJECT:'demo-llenamos',FIRESTORE_EMULATOR_HOST:'127.0.0.1:8096',FIREBASE_AUTH_EMULATOR_HOST:'127.0.0.1:9102',FIREBASE_STORAGE_EMULATOR_HOST:'127.0.0.1:9212',PLATFORM_DATA_KEY_V1:readFileSync(keyPath,'utf8').trim() }
const [command,...args] = process.argv.slice(2)
if (!command) throw new Error('Indica el ejecutable local y sus argumentos.')
const child = spawn(command,args,{ env,stdio:'inherit' })
writeFileSync('/tmp/llenamos-copias-proceso.pid',String(child.pid))
for (const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,() => { if (!child.killed) child.kill(signal) })
child.on('error',error => { console.error(error.message);process.exitCode=1 })
child.on('exit',code => { process.exitCode=code ?? 1 })
