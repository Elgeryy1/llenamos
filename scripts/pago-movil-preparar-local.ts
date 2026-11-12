import { readFileSync, writeFileSync } from 'node:fs'
if (process.cwd().split('/').at(-1) !== 'f3-pago-movil') throw new Error('Ejecuta este script desde el worktree de pago móvil.')
const config = JSON.parse(readFileSync('firebase.json', 'utf8'))
// Firebase necesita un websocket adicional. Se reserva el puerto propio de UI y se apaga esta.
config.emulators = { ...config.emulators, auth: { port: 9106 }, firestore: { port: 8100, websocketPort: 4015 }, functions: { port: 5016 },
  storage: { port: 9216 }, ui: { enabled: false, port: 4015 }, hub: { port: 4415 }, logging: { port: 4515 },
  eventarc: { port: 9315 }, tasks: { port: 9515 }, singleProjectMode: true }
writeFileSync('firebase.agente5.json', JSON.stringify(config, null, 2) + '\n')
writeFileSync('apps/web/.env.local', readFileSync('apps/web/.env.example', 'utf8') + '\nNEXT_PUBLIC_AUTH_EMULATOR_PORT=9106\nNEXT_PUBLIC_FIRESTORE_EMULATOR_PORT=8100\nNEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT=5016\nNEXT_PUBLIC_STORAGE_EMULATOR_PORT=9216\nNEXT_PUBLIC_SITE_URL=http://localhost:3015\n')
// Solo un secreto HMAC público de ejemplo. No configura ni permite ningún cobro.
writeFileSync('functions/.env.local', 'PUBLIC_APP_URL=http://localhost:3015\nSTRIPE_MOBILE_WEBHOOK_SECRET=mobile_local_example\n')
console.log('Configuración local de la fila 5 preparada. No hay clave de Stripe.')
