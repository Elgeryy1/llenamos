/** Cliente de identidad: este módulo no carga SDK de datos, archivos ni funciones. */
import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app"
import { connectAuthEmulator, getAuth, type Auth } from "firebase/auth"
import { firebaseConfig } from "./config"
import { FirebaseConfigError } from "./config-error"

export interface FirebaseIdentityClient { app: FirebaseApp; auth: Auth }
const holder = globalThis as typeof globalThis & { __llenamosFirebaseIdentity?: FirebaseIdentityClient }

export function getFirebaseIdentity(): FirebaseIdentityClient {
  if (holder.__llenamosFirebaseIdentity) return holder.__llenamosFirebaseIdentity
  if (!firebaseConfig.ok) throw new FirebaseConfigError(firebaseConfig.problems)
  const { settings } = firebaseConfig
  const app = getApps().length ? getApp() : initializeApp(settings.options)
  if (app.options.projectId !== settings.options.projectId) throw new FirebaseConfigError(["La instancia de identidad pertenece a otro proyecto."])
  const auth = getAuth(app)
  // También puede haberse conectado desde el cliente legacy en una sesión local.
  if (settings.emulators && !auth.emulatorConfig) {
    const { host, ports } = settings.emulators
    connectAuthEmulator(auth, `http://${host}:${ports.auth}`, { disableWarnings: true })
  }
  holder.__llenamosFirebaseIdentity = { app, auth }
  return holder.__llenamosFirebaseIdentity
}

export async function identityToken(): Promise<string> {
  const user = getFirebaseIdentity().auth.currentUser
  if (!user) throw new Error("Inicia sesión para continuar.")
  return user.getIdToken()
}
