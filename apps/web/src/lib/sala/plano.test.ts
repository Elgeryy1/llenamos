import { describe, expect, it } from "vitest"
import type { AreaDoc, TableDoc } from "@/lib/data/parse"
import { describeTable, overlappingTables, planByArea, tableBox, tableStats } from "./plano"

function t(id: string, patch: Partial<TableDoc> = {}): TableDoc {
  return {
    id,
    name: id.toUpperCase(),
    areaId: "sala",
    seats: 4,
    shape: "rect",
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    joinableWith: [],
    enabled: true,
    ...patch,
  }
}

const areas: AreaDoc[] = [
  { id: "terraza", name: "Terraza", sortOrder: 2 },
  { id: "sala", name: "Sala", sortOrder: 1 },
]

describe("planByArea", () => {
  it("ordena las zonas por sortOrder y las mesas por nombre con números", () => {
    const plans = planByArea(areas, [t("s10"), t("s2"), t("t1", { areaId: "terraza" })])
    expect(plans.map((p) => p.area?.name)).toEqual(["Sala", "Terraza"])
    expect(plans[0]!.tables.map((x) => x.name)).toEqual(["S2", "S10"])
  })

  it("deja una zona vacía como vacía y junta las mesas huérfanas al final", () => {
    const plans = planByArea(areas, [t("x", { areaId: "borrada" })])
    expect(plans.map((p) => p.area?.id ?? null)).toEqual(["sala", "terraza", null])
    expect(plans[2]!.tables).toHaveLength(1)
  })
})

describe("tableStats", () => {
  it("las plazas solo cuentan las mesas habilitadas", () => {
    expect(tableStats([t("a", { seats: 2 }), t("b", { seats: 6, enabled: false }), t("c", { seats: 4 })])).toEqual({
      tables: 3,
      enabled: 2,
      seats: 6,
    })
  })
})

describe("tableBox", () => {
  it("pasa la rejilla de 0 a 100 a porcentajes", () => {
    expect(tableBox({ x: 10, y: 20, w: 12, h: 18 })).toEqual({ left: "10%", top: "20%", width: "12%", height: "18%" })
  })

  it("mete dentro del plano una mesa que se sale", () => {
    expect(tableBox({ x: 95, y: 90, w: 12, h: 18 })).toEqual({ left: "88%", top: "82%", width: "12%", height: "18%" })
  })
})

describe("overlappingTables", () => {
  it("encuentra mesas que se pisan en la misma zona", () => {
    const tables = [t("a", { x: 0, w: 10 }), t("b", { x: 5, w: 10 }), t("c", { x: 10, w: 10 }), t("d", { x: 5, areaId: "terraza" })]
    expect(overlappingTables(tables)).toEqual([["a", "b"], ["b", "c"]])
  })
})

describe("describeTable", () => {
  it("describe la mesa para lectores de pantalla", () => {
    const names = new Map([["s5", "S5"]])
    expect(describeTable(t("s4", { shape: "round", joinableWith: ["s5", "nada"] }), names)).toBe(
      "Mesa S4, 4 plazas, redonda, se puede juntar con S5",
    )
    expect(describeTable(t("b", { seats: 1, enabled: false }), names)).toBe("Mesa B, 1 plaza, rectangular, deshabilitada")
  })
})
