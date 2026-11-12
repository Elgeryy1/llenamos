import type { Member, Role } from "@llenamos/core"
import { describe, expect, it } from "vitest"
import { initials, sortMembers, teamActions } from "./equipo"

function m(uid: string, role: Role, active = true, displayName = uid): Member {
  return { uid, role, active, displayName, email: `${uid}@lumbre.test`, locationIds: [] }
}

const owner = m("marta", "owner")
const owner2 = m("pere", "owner")
const manager = m("laia", "manager")
const waiter = m("pau", "waiter")
const team = [owner, manager, waiter]

describe("teamActions", () => {
  it("nadie se gestiona a sí mismo", () => {
    const a = teamActions(owner, owner, team)
    expect(a.canChangeRole || a.canDeactivate).toBe(false)
    expect(a.reason).toContain("Eres tú")
  })

  it("camareros, cocina y barra no gestionan a nadie", () => {
    for (const role of ["waiter", "kitchen", "bar"] as const) {
      const a = teamActions({ uid: "x", role }, waiter, team)
      expect(a).toEqual({ canChangeRole: false, roleOptions: [], canDeactivate: false, reason: null })
    }
  })

  it("el owner puede dar cualquier rol", () => {
    const a = teamActions(owner, waiter, team)
    expect(a.canChangeRole).toBe(true)
    expect(a.canDeactivate).toBe(true)
    expect(a.roleOptions).toEqual(["owner", "manager", "waiter", "kitchen", "bar"])
  })

  it("el manager no puede dar el rol de owner", () => {
    const a = teamActions(manager, waiter, team)
    expect(a.roleOptions).toEqual(["manager", "waiter", "kitchen", "bar"])
  })

  it("el manager no toca a un owner", () => {
    const a = teamActions(manager, owner, team)
    expect(a.canChangeRole || a.canDeactivate).toBe(false)
    expect(a.reason).toContain("propietario")
  })

  it("el restaurante no se queda sin owner", () => {
    const a = teamActions(owner, owner2, [owner2, m("marta", "owner", false), manager])
    expect(a.canChangeRole || a.canDeactivate).toBe(false)
    expect(a.reason).toContain("único propietario")
  })

  it("con dos owners activos, uno puede cambiar al otro", () => {
    const a = teamActions(owner, owner2, [owner, owner2])
    expect(a.canChangeRole && a.canDeactivate).toBe(true)
  })

  it("a una persona desactivada no se le cambia nada", () => {
    const a = teamActions(owner, m("ex", "waiter", false), team)
    expect(a.canChangeRole || a.canDeactivate).toBe(false)
  })
})

describe("sortMembers", () => {
  it("activos primero, luego por rol y por nombre", () => {
    const sorted = sortMembers([
      m("z", "waiter", true, "Zoe"),
      m("a", "waiter", false, "Ana"),
      m("b", "waiter", true, "Bea"),
      m("o", "owner", true, "Óscar"),
    ])
    expect(sorted.map((x) => x.displayName)).toEqual(["Óscar", "Bea", "Zoe", "Ana"])
  })
})

describe("initials", () => {
  it("usa la primera y la última palabra", () => {
    expect(initials("Laia Ferrer")).toBe("LF")
    expect(initials("Maria del Mar Soler")).toBe("MS")
    expect(initials("cocina")).toBe("C")
    expect(initials("  ")).toBe("?")
  })
})
