import type { FirebaseSettings } from "@/lib/firebase/config"

export class DataBackendConfigError extends Error {
  readonly code = "config"
  constructor() {
    super("El servidor de datos no está configurado. Selecciona PostgreSQL para la API del VPS; Firebase de datos solo se permite en los emuladores de demostración.")
    this.name = "DataBackendConfigError"
  }
}

/** El selector público se sustituye al compilar; nunca se deduce PostgreSQL de una URL. */
export function dataBackend(
  settings: FirebaseSettings | null,
  selected: string | undefined = process.env.NEXT_PUBLIC_DATA_BACKEND,
): "postgres" | "firebase-demo" {
  if (selected === "postgres") return "postgres"
  if ((!selected || selected === "firebase-demo") && settings?.emulators && settings.options.projectId?.startsWith("demo-")) return "firebase-demo"
  throw new DataBackendConfigError()
}
