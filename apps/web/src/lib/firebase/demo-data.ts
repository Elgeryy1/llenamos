/**
 * Transporte de datos de la demo con emuladores (Firestore y Functions). Solo existe para el
 * modo `firebase-demo`: con `NEXT_PUBLIC_DATA_BACKEND=postgres` nunca se inicializa. La
 * identidad vive aparte en `auth-client.ts`, que no carga ningún SDK de datos.
 */
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore"
import { connectFunctionsEmulator, getFunctions, type Functions } from "firebase/functions"
import { dataBackend } from "@/lib/api/config"
import { getFirebaseIdentity } from "./auth-client"
import { firebaseConfig, type FirebaseSettings } from "./config"
import { FirebaseConfigError } from "./config-error"

export interface DemoData { db: Firestore; functions: Functions; settings: FirebaseSettings }
// Se guarda en globalThis para sobrevivir a la recarga en caliente: conectar dos veces al mismo emulador lanza.
const holder = globalThis as typeof globalThis & { __llenamosDemoData?: DemoData }

export function getDemoData(): DemoData {
  if (!firebaseConfig.ok) throw new FirebaseConfigError(firebaseConfig.problems)
  const { settings } = firebaseConfig
  if (dataBackend(settings) !== "firebase-demo") throw new FirebaseConfigError(["Este módulo de datos todavía no está migrado al servidor del VPS."])
  if (holder.__llenamosDemoData) return holder.__llenamosDemoData
  const { app } = getFirebaseIdentity()
  const db = getFirestore(app)
  const functions = getFunctions(app, settings.region)
  if (settings.emulators) {
    const { host, ports } = settings.emulators
    connectFirestoreEmulator(db, host, ports.firestore)
    connectFunctionsEmulator(functions, host, ports.functions)
  }
  holder.__llenamosDemoData = { db, functions, settings }
  return holder.__llenamosDemoData
}
