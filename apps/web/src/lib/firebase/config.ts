/**
 * Configuración de Firebase en el navegador, leída de las variables NEXT_PUBLIC_*.
 *
 * Es lógica pura (sin Firebase) para poder probarla. Si falta algo, no se inventa:
 * se devuelve qué falta y la interfaz lo enseña.
 */
import type { FirebaseOptions } from "firebase/app"

/** Región de las funciones según el contrato (ARQUITECTURA.md). */
export const DEFAULT_FUNCTIONS_REGION = "europe-west1"

/** Puertos de los emuladores según el contrato. */
export const DEFAULT_EMULATOR_PORTS = {
  auth: 9099,
  firestore: 8085,
  functions: 5001,
  storage: 9199,
} as const

export type PublicEnv = Partial<Record<(typeof PUBLIC_ENV_KEYS)[number], string>>

export const PUBLIC_ENV_KEYS = [
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
  "NEXT_PUBLIC_USE_EMULATORS",
  "NEXT_PUBLIC_FUNCTIONS_REGION",
  "NEXT_PUBLIC_EMULATOR_HOST",
  "NEXT_PUBLIC_AUTH_EMULATOR_PORT",
  "NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT",
  "NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT",
  "NEXT_PUBLIC_STORAGE_EMULATOR_PORT",
] as const

/**
 * Next solo sustituye las variables públicas cuando se escriben enteras
 * (process.env.NEXT_PUBLIC_X), así que se leen una a una.
 */
export function readPublicEnv(): PublicEnv {
  return {
    NEXT_PUBLIC_FIREBASE_PROJECT_ID: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    NEXT_PUBLIC_FIREBASE_API_KEY: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    NEXT_PUBLIC_FIREBASE_APP_ID: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
    NEXT_PUBLIC_USE_EMULATORS: process.env.NEXT_PUBLIC_USE_EMULATORS,
    NEXT_PUBLIC_FUNCTIONS_REGION: process.env.NEXT_PUBLIC_FUNCTIONS_REGION,
    NEXT_PUBLIC_EMULATOR_HOST: process.env.NEXT_PUBLIC_EMULATOR_HOST,
    NEXT_PUBLIC_AUTH_EMULATOR_PORT: process.env.NEXT_PUBLIC_AUTH_EMULATOR_PORT,
    NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT: process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT,
    NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT: process.env.NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT,
    NEXT_PUBLIC_STORAGE_EMULATOR_PORT: process.env.NEXT_PUBLIC_STORAGE_EMULATOR_PORT,
  }
}

export interface EmulatorSettings {
  host: string
  ports: { auth: number; firestore: number; functions: number; storage: number }
}

export interface FirebaseSettings {
  options: FirebaseOptions
  region: string
  /** null = se usa Firebase de verdad (no en esta fase). */
  emulators: EmulatorSettings | null
}

export type ConfigResult = { ok: true; settings: FirebaseSettings } | { ok: false; problems: string[] }

const REQUIRED = [
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
] as const

function clean(value: string | undefined): string | undefined {
  const v = value?.trim()
  return v ? v : undefined
}

function parsePort(
  env: PublicEnv,
  key: (typeof PUBLIC_ENV_KEYS)[number],
  fallback: number,
  problems: string[],
): number {
  const raw = clean(env[key])
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    problems.push(`${key} debe ser un puerto entre 1 y 65535 (ahora vale «${raw}»).`)
    return fallback
  }
  return n
}

export function parseFirebaseEnv(env: PublicEnv): ConfigResult {
  const problems: string[] = []
  for (const key of REQUIRED) {
    if (!clean(env[key])) problems.push(`Falta ${key}.`)
  }

  const useEmulators = clean(env.NEXT_PUBLIC_USE_EMULATORS) === "1"
  const projectId = clean(env.NEXT_PUBLIC_FIREBASE_PROJECT_ID)
  if (projectId?.startsWith("demo-") && !useEmulators) {
    problems.push(
      `El proyecto ${projectId} es de demostración y solo funciona con los emuladores: pon NEXT_PUBLIC_USE_EMULATORS=1.`,
    )
  }

  let emulators: EmulatorSettings | null = null
  if (useEmulators) {
    emulators = {
      host: clean(env.NEXT_PUBLIC_EMULATOR_HOST) ?? "127.0.0.1",
      ports: {
        auth: parsePort(env, "NEXT_PUBLIC_AUTH_EMULATOR_PORT", DEFAULT_EMULATOR_PORTS.auth, problems),
        firestore: parsePort(env, "NEXT_PUBLIC_FIRESTORE_EMULATOR_PORT", DEFAULT_EMULATOR_PORTS.firestore, problems),
        functions: parsePort(env, "NEXT_PUBLIC_FUNCTIONS_EMULATOR_PORT", DEFAULT_EMULATOR_PORTS.functions, problems),
        storage: parsePort(env, "NEXT_PUBLIC_STORAGE_EMULATOR_PORT", DEFAULT_EMULATOR_PORTS.storage, problems),
      },
    }
  }

  if (problems.length > 0) return { ok: false, problems }

  const options: FirebaseOptions = {
    projectId,
    apiKey: clean(env.NEXT_PUBLIC_FIREBASE_API_KEY),
    appId: clean(env.NEXT_PUBLIC_FIREBASE_APP_ID),
    authDomain: clean(env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN),
    storageBucket: clean(env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET),
  }

  return {
    ok: true,
    settings: {
      options,
      region: clean(env.NEXT_PUBLIC_FUNCTIONS_REGION) ?? DEFAULT_FUNCTIONS_REGION,
      emulators,
    },
  }
}

/** Resultado para esta web, calculado una vez. */
export const firebaseConfig: ConfigResult = parseFirebaseEnv(readPublicEnv())
