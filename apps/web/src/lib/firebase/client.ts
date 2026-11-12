/**
 * Compatibilidad de la demo local: junta la identidad (`auth-client.ts`, solo Auth) con el
 * transporte de datos de los emuladores (`demo-data.ts`). El código nuevo debe usar el que
 * necesite: `getFirebaseIdentity()` para la cuenta y, solo en la rama demo, `getDemoData()`.
 * En modo VPS `getFirebase()` falla antes de inicializar Firestore o Functions.
 */
import type { FirebaseApp } from "firebase/app"
import type { Auth } from "firebase/auth"
import type { Firestore } from "firebase/firestore"
import type { Functions } from "firebase/functions"
import { getFirebaseIdentity } from "./auth-client"
import type { FirebaseSettings } from "./config"
import { getDemoData } from "./demo-data"
export { FirebaseConfigError } from "./config-error"

export interface FirebaseClients {
  app: FirebaseApp
  auth: Auth
  db: Firestore
  functions: Functions
  settings: FirebaseSettings
}

export function getFirebase(): FirebaseClients {
  const data = getDemoData()
  const { app, auth } = getFirebaseIdentity()
  return { app, auth, db: data.db, functions: data.functions, settings: data.settings }
}
