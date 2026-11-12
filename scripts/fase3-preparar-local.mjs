// Configuración exclusivamente local de la fila 5. No configura ninguna clave bancaria.
import { readFileSync, writeFileSync } from 'node:fs'
const config = JSON.parse(readFileSync('firebase.json', 'utf8'))
config.emulators = { auth: { port: 9106 }, firestore: { port: 8100, websocketPort: 4015 }, functions: { port: 5016 }, storage: { port: 9216 }, ui: { enabled: false, port: 4015 }, hub: { port: 4415 }, logging: { port: 4515 }, eventarc: { port: 9315 }, tasks: { port: 9515 }, singleProjectMode: true }
writeFileSync('firebase.agente5.json', JSON.stringify(config, null, 2) + '\n')
writeFileSync('apps/web/.env.local', readFileSync('apps/web/.env.example', 'utf8') + '\nNEXT_PUBLIC_AUTH_EMULATOR_PORT=9106\nNEXT_PUBLIC_FIRESTORE_EMULATOR_PORT=8100\nNEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT=5016\nNEXT_PUBLIC_STORAGE_EMULATOR_PORT=9216\nNEXT_PUBLIC_SITE_URL=http://localhost:3015\n')
writeFileSync('functions/.env.local', 'PUBLIC_APP_URL=http://localhost:3015\nSTRIPE_MOBILE_WEBHOOK_SECRET=mobile_local_example\n')
console.log('Fila 5 preparada. UI reservada al websocket de Firestore. Sin clave de Stripe.')
