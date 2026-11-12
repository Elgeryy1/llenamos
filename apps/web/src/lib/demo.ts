/**
 * Cuentas del restaurante de demostración (ARQUITECTURA.md, «pnpm seed»).
 * Solo se enseñan cuando la web va contra los emuladores.
 */
import type { Role } from "@llenamos/core"

export const DEMO_PASSWORD = "Llenamos2026!"

export interface DemoAccount {
  email: string
  role: Role
}

export const DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { email: "propietario@lumbre.test", role: "owner" },
  { email: "encargada@lumbre.test", role: "manager" },
  { email: "camarero@lumbre.test", role: "waiter" },
  { email: "camarera@lumbre.test", role: "waiter" },
  { email: "cocina@lumbre.test", role: "kitchen" },
  { email: "barra@lumbre.test", role: "bar" },
]

export const LOCALE_LABEL = {
  es: "Castellano",
  ca: "Català",
  en: "English",
} as const
