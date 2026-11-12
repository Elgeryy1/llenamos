import { describe, expect, it } from "vitest"
import { addArea, addTable, deleteArea, deleteTable, diffDraft, moveTable, type PlanoDraft } from "./editor"
import { PlanoSaveError, planWriteSteps } from "./guardar"

const base: PlanoDraft = {
  areas: [
    { id: "sala", name: "Sala", sortOrder: 0 },
    { id: "vieja", name: "Vieja", sortOrder: 1 },
  ],
  tables: [{ id: "s1", name: "S1", areaId: "sala", seats: 4, shape: "rect", x: 5, y: 5, w: 10, h: 10, joinableWith: [], enabled: true }],
}

describe("pasos del guardado", () => {
  it("primero zonas, luego mesas y al final zonas borradas", () => {
    let d = addArea(base, "patio", "Patio")
    d = addTable(d, "patio", "p1")
    d = moveTable(d, "s1", 30, 30)
    d = deleteArea(d, "vieja")
    const steps = planWriteSteps(diffDraft(base, d))
    expect(steps.map((s) => s.label)).toEqual(["zonas", "mesas", "zonas borradas"])
    expect(steps[0]?.ops).toEqual([{ kind: "create", collection: "areas", id: "patio", data: { name: "Patio", sortOrder: 2 } }])
    expect(steps[1]?.ops.map((o) => [o.kind, o.id])).toEqual([
      ["create", "p1"],
      ["update", "s1"],
    ])
    expect(steps[2]?.ops).toEqual([{ kind: "delete", collection: "areas", id: "vieja" }])
  })

  it("se salta los pasos vacíos", () => {
    const steps = planWriteSteps(diffDraft(base, deleteTable(base, "s1")))
    expect(steps).toEqual([{ label: "mesas", ops: [{ kind: "delete", collection: "tables", id: "s1" }] }])
  })

  it("el error dice qué se guardó y qué no", () => {
    expect(new PlanoSaveError("mesas", ["zonas"], null).message).toBe("Se han guardado las zonas, pero no las mesas.")
    expect(new PlanoSaveError("zonas", [], null).message).toBe("No se han podido guardar las zonas.")
  })
})
