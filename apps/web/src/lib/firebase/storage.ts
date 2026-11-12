/**
 * SOLO DEMO (emuladores). En el VPS los archivos van por `lib/api/files.ts`; `getFirebase()` falla en modo `postgres`
 * antes de tocar Storage. Solo se importa con `import()` dentro de la rama demo.
 */
import { connectStorageEmulator, getStorage, type FirebaseStorage } from "firebase/storage"
import { getFirebase } from "./client"

const holder = globalThis as typeof globalThis & { __llenamosStorage?: FirebaseStorage }

export function getStorageClient(): FirebaseStorage {
  if (holder.__llenamosStorage) return holder.__llenamosStorage
  const { app, settings } = getFirebase()
  const storage = getStorage(app)
  if (settings.emulators) {
    connectStorageEmulator(storage, settings.emulators.host, settings.emulators.ports.storage)
  }
  holder.__llenamosStorage = storage
  return storage
}
