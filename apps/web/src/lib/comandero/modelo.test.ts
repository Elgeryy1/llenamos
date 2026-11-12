import { describe, expect, it } from "vitest"
import type { TableSessionWithId } from "@llenamos/core"
import { euros, firmaMesa, revisarDestino } from "./modelo"

// Sesión de ejemplo de prueba. Nunca se carga en la pantalla real.
export const mesaEjemplo: TableSessionWithId = {
  id: "s1",
  status: "open",
  tableIds: ["sala-1"],
  label: "S1",
  guests: 2,
  reservationId: null,
  customerId: null,
  guestName: null,
  waiterUid: "u1",
  waiterName: "Diego",
  notes: "",
  openedAt: 100,
  openedBy: "u1",
  closedAt: null,
  closedBy: null,
  billRequestedAt: null,
  mergedInto: null,
  totalCents: 0,
  lineCount: 0,
  unservedCount: 0,
  history: [],
}

describe("revisión del destino de un pedido", () => {
  it("mantiene la mesa y tolera actualizaciones de los totales", () => {
    expect(
      revisarDestino(firmaMesa(mesaEjemplo), {
        ...mesaEjemplo,
        totalCents: 650,
        lineCount: 1,
      }),
    ).toBeNull()
  })
  it("obliga a revisar si otra persona mueve, separa o cambia comensales", () => {
    for (const cambio of [
      { tableIds: ["sala-2"] },
      { tableIds: ["sala-1", "sala-2"] },
      { guests: 3 },
      { customerId: "01234567890123456789" },
    ])
      expect(
        revisarDestino(firmaMesa(mesaEjemplo), { ...mesaEjemplo, ...cambio }),
      ).toContain("ha cambiado")
  })
  it("bloquea si desaparece, se cierra o se junta con otra sesión", () => {
    expect(revisarDestino(firmaMesa(mesaEjemplo), null)).toContain("sin enviar")
    for (const status of ["closed", "merged", "cancelled"] as const)
      expect(
        revisarDestino(firmaMesa(mesaEjemplo), { ...mesaEjemplo, status }),
      ).toContain("sin enviar")
    expect(
      revisarDestino(firmaMesa(mesaEjemplo), { ...mesaEjemplo, id: "otra" }),
    ).toContain("ha cambiado")
  })
  it("formatea céntimos enteros sin cambiar la unidad de cálculo", () =>
    expect(euros(1234)).toMatch(/12,34/))
})
