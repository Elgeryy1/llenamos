/**
 * Qué se puede hacer con cada persona del equipo. Repite en la interfaz las
 * reglas del contrato para no ofrecer botones que el servidor va a rechazar:
 * - solo owner y manager gestionan el equipo;
 * - nadie se cambia a sí mismo;
 * - solo un owner toca a otro owner (propietarios.gestionar);
 * - el restaurante no se queda nunca sin owner activo;
 * - solo se dan roles de assignableRoles().
 */
import { assignableRoles, can, ROLES, type Member, type Role } from "@llenamos/core"

export interface TeamActions {
  canChangeRole: boolean
  roleOptions: Role[]
  canDeactivate: boolean
  /** Por qué no se puede, para enseñarlo junto a la persona. */
  reason: string | null
}

const NONE = (reason: string | null): TeamActions => ({
  canChangeRole: false,
  roleOptions: [],
  canDeactivate: false,
  reason,
})

export function activeOwnerCount(members: readonly Member[]): number {
  return members.filter((m) => m.active && m.role === "owner").length
}

export function teamActions(
  me: { uid: string; role: Role },
  target: Member,
  members: readonly Member[],
): TeamActions {
  if (!can(me.role, "equipo.gestionar")) return NONE(null)
  if (target.uid === me.uid) return NONE("Eres tú. Otra persona con permiso puede cambiar tu rol.")
  if (!target.active) return NONE("Está desactivada.")
  if (target.role === "owner" && !can(me.role, "propietarios.gestionar")) {
    return NONE("Solo un propietario puede cambiar a otro propietario.")
  }

  const lastOwner = target.role === "owner" && activeOwnerCount(members) <= 1
  if (lastOwner) return NONE("Es el único propietario. Nombra antes a otro.")

  const options = assignableRoles(me.role)
  // El rol actual siempre aparece, aunque no se pudiera asignar, para que la lista no mienta.
  const roleOptions = ROLES.filter((r) => options.includes(r) || r === target.role)

  return { canChangeRole: options.length > 0, roleOptions, canDeactivate: true, reason: null }
}

const ROLE_ORDER: Record<Role, number> = { owner: 0, manager: 1, waiter: 2, kitchen: 3, bar: 4 }

/** Orden de la lista: primero activos, por rol y luego por nombre. */
export function sortMembers<T extends Member>(members: readonly T[]): T[] {
  return [...members].sort(
    (a, b) =>
      Number(b.active) - Number(a.active) ||
      ROLE_ORDER[a.role] - ROLE_ORDER[b.role] ||
      a.displayName.localeCompare(b.displayName, "es"),
  )
}

/** Iniciales para el avatar: «Laia Ferrer» → «LF». */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? [parts[0]!, parts.at(-1)!] : parts
  return letters.map((p) => p[0]!.toUpperCase()).join("") || "?"
}
