import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const valid = {
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'llenamos-production',
  NEXT_PUBLIC_FIREBASE_API_KEY: 'public-config',
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'llenamos-production.firebaseapp.com',
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: 'llenamos-production.firebasestorage.app',
  NEXT_PUBLIC_FIREBASE_APP_ID: 'public-app-id',
  NEXT_PUBLIC_USE_EMULATORS: '0',
  NEXT_PUBLIC_DATA_BACKEND: 'postgres',
  NEXT_PUBLIC_SITE_URL: 'https://app.example.com', VITE_APP_URL: 'https://app.example.com',
}
const run = changes => spawnSync(process.execPath, [fileURLToPath(new URL('./validate-public-env.mjs', import.meta.url))], {
  env: { ...process.env, ...valid, ...changes }, encoding: 'utf8',
})
test('acepta configuración pública completa sin acceder a Firebase', () => assert.equal(run({}).status, 0))
test('Auth no exige un bucket Firebase Storage', () => assert.equal(run({NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET:''}).status, 0))
for (const changes of [
  { NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-llenamos' },
  { NEXT_PUBLIC_USE_EMULATORS: '1' },
  { NEXT_PUBLIC_DATA_BACKEND: '' },
  { NEXT_PUBLIC_FIREBASE_APP_ID: '' },
  { NEXT_PUBLIC_SITE_URL: 'http://localhost:3000' },
  { VITE_APP_URL: 'https://otro.example.com' },
  { VITE_APP_URL: 'https://user:password@app.example.com' },
]) test(`rechaza configuración no productiva ${Object.keys(changes)[0]}=${Object.values(changes)[0]}`, () => assert.notEqual(run(changes).status, 0))
