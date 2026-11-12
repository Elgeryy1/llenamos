import { describe, expect, it } from "vitest"
import {
  addArea,
  addTable,
  canDeleteArea,
  countChanges,
  deleteArea,
  deleteTable,
  diffDraft,
  fitBox,
  moveArea,
  moveTable,
  moveTableToArea,
  namePrefix,
  nextTableName,
  normalizeJoins,
  nudgeTable,
  pixelsToGrid,
  resizeTable,
  setEnabled,
  setJoinable,
  setSeats,
  snap,
  sortedAreas,
  toggleShape,
  validateDraft,
  type EditorTable,
  type PlanoDraft,
} from "./editor"

function mesa(id: string, over: Partial<EditorTable> = {}): EditorTable {
  return { id, name: id.toUpperCase(), areaId: "sala", seats: 4, shape: "rect", x: 0, y: 0, w: 10, h: 10, joinableWith: [], enabled: true, ...over }
}

const base: PlanoDraft = {
  areas: [
    { id: "sala", name: "Sala", sortOrder: 0 },
    { id: "terraza", name: "Terraza", sortOrder: 1 },
  ],
  tables: [
    mesa("s1", { x: 5, y: 5 }),
    mesa("s2", { x: 20, y: 5 }),
    mesa("t1", { areaId: "terraza", x: 5, y: 5 }),
  ],
}

const get = (d: PlanoDraft, id: string) => d.tables.find((t) => t.id === id)!

describe("posiciones y tamaños", () => {
  it("redondea a la rejilla", () => {
    expect(snap(12.4)).toBe(12)
    expect(snap(12.6)).toBe(13)
    expect(snap(7, 5)).toBe(5)
  })

  it("mover deja la mesa dentro del plano", () => {
    const d = moveTable(base, "s1", 97, -3)
    expect(get(d, "s1")).toMatchObject({ x: 90, y: 0, w: 10, h: 10 })
  })

  it("las flechas desplazan la mesa", () => {
    expect(get(nudgeTable(base, "s1", 1, 5), "s1")).toMatchObject({ x: 6, y: 10 })
    expect(nudgeTable(base, "nada", 1, 1)).toBe(base)
  })

  it("redimensionar respeta el mínimo y el borde", () => {
    const d = resizeTable(base, "s2", 200, 1)
    expect(get(d, "s2")).toMatchObject({ x: 20, w: 80, h: 4 })
  })

  it("fitBox mete una caja que se sale", () => {
    expect(fitBox({ x: 95, y: 95, w: 10, h: 10 })).toEqual({ x: 90, y: 90, w: 10, h: 10 })
  })

  it("pasa de píxeles a la rejilla", () => {
    expect(pixelsToGrid(80, 50, 800, 500)).toEqual({ dx: 10, dy: 10 })
    expect(pixelsToGrid(10, 10, 0, 0)).toEqual({ dx: 0, dy: 0 })
  })
})

describe("forma, plazas y habilitar", () => {
  it("gira entre redonda y rectangular", () => {
    const d = toggleShape(base, "s1")
    expect(get(d, "s1").shape).toBe("round")
    expect(get(toggleShape(d, "s1"), "s1").shape).toBe("rect")
  })

  it("las plazas van de 1 a 30", () => {
    expect(get(setSeats(base, "s1", 0), "s1").seats).toBe(1)
    expect(get(setSeats(base, "s1", 99), "s1").seats).toBe(30)
    expect(setSeats(base, "s1", Number.NaN)).toBe(base)
  })

  it("deshabilita una mesa", () => {
    expect(get(setEnabled(base, "s2", false), "s2").enabled).toBe(false)
  })
})

describe("crear y borrar mesas", () => {
  it("el prefijo sale de la zona", () => {
    expect(namePrefix("Sala")).toBe("S")
    expect(namePrefix("Ático")).toBe("A")
    expect(namePrefix("1ª planta")).toBe("M")
  })

  it("el nombre nuevo no se repite en todo el local", () => {
    expect(nextTableName(base, "sala")).toBe("S3")
    expect(nextTableName(base, "terraza")).toBe("T2")
  })

  it("la mesa nueva cae en un hueco libre", () => {
    const d = addTable(base, "sala", "nueva")
    const t = get(d, "nueva")
    expect(t).toMatchObject({ name: "S3", areaId: "sala", seats: 4, enabled: true, joinableWith: [] })
    expect(validateDraft(d)).toEqual([])
  })

  it("borrar una mesa la quita de las uniones", () => {
    const unidas = setJoinable(base, "s1", "s2", true)
    const d = deleteTable(unidas, "s2")
    expect(d.tables.map((t) => t.id)).toEqual(["s1", "t1"])
    expect(get(d, "s1").joinableWith).toEqual([])
  })
})

describe("uniones simétricas", () => {
  it("unir marca las dos mesas", () => {
    const d = setJoinable(base, "s2", "s1", true)
    expect(get(d, "s1").joinableWith).toEqual(["s2"])
    expect(get(d, "s2").joinableWith).toEqual(["s1"])
  })

  it("separar las desmarca en los dos sentidos", () => {
    const d = setJoinable(setJoinable(base, "s1", "s2", true), "s2", "s1", false)
    expect(get(d, "s1").joinableWith).toEqual([])
    expect(get(d, "s2").joinableWith).toEqual([])
  })

  it("no se une con otra zona ni consigo misma", () => {
    expect(setJoinable(base, "s1", "t1", true)).toBe(base)
    expect(setJoinable(base, "s1", "s1", true)).toBe(base)
  })

  it("unir dos veces no duplica", () => {
    const d = setJoinable(setJoinable(base, "s1", "s2", true), "s1", "s2", true)
    expect(get(d, "s1").joinableWith).toEqual(["s2"])
  })

  it("normaliza uniones a medias, a otra zona o a mesas que no existen", () => {
    const roto: PlanoDraft = {
      ...base,
      tables: [mesa("s1", { joinableWith: ["s2", "t1", "fantasma"] }), mesa("s2", { x: 20 }), mesa("t1", { areaId: "terraza" })],
    }
    const d = normalizeJoins(roto)
    expect(get(d, "s1").joinableWith).toEqual(["s2"])
    expect(get(d, "s2").joinableWith).toEqual(["s1"])
    expect(get(d, "t1").joinableWith).toEqual([])
  })

  it("cambiar de zona quita las uniones", () => {
    const d = moveTableToArea(setJoinable(base, "s1", "s2", true), "s1", "terraza")
    expect(get(d, "s1")).toMatchObject({ areaId: "terraza", joinableWith: [] })
    expect(get(d, "s2").joinableWith).toEqual([])
    expect(validateDraft(d)).toEqual([])
  })
})

describe("zonas", () => {
  it("crea una zona al final", () => {
    const d = addArea(base, "patio", "Patio")
    expect(sortedAreas(d).map((a) => a.id)).toEqual(["sala", "terraza", "patio"])
    expect(d.areas.find((a) => a.id === "patio")?.sortOrder).toBe(2)
  })

  it("ordena zonas arriba y abajo", () => {
    const d = moveArea(base, "terraza", -1)
    expect(sortedAreas(d).map((a) => a.id)).toEqual(["terraza", "sala"])
    expect(moveArea(base, "sala", -1)).toBe(base)
  })

  it("solo se borra una zona vacía", () => {
    expect(canDeleteArea(base, "sala")).toBe(false)
    expect(deleteArea(base, "sala")).toBe(base)
    const d = deleteArea(addArea(base, "patio", "Patio"), "patio")
    expect(d.areas.map((a) => a.id)).toEqual(["sala", "terraza"])
  })
})

describe("validación", () => {
  it("un plano bien puesto no tiene problemas", () => {
    expect(validateDraft(base)).toEqual([])
  })

  it("avisa de mesas que se pisan en la misma zona", () => {
    const d = moveTable(base, "s2", 8, 8)
    expect(validateDraft(d)).toEqual([{ id: "s2", kind: "table", message: "Las mesas S1 y S2 se pisan." }])
  })

  it("mesas en zonas distintas pueden ocupar el mismo sitio", () => {
    const d = moveTable(base, "t1", 5, 5)
    expect(validateDraft(d)).toEqual([])
  })

  it("avisa de nombres vacíos o repetidos", () => {
    const d: PlanoDraft = { ...base, tables: [...base.tables, mesa("s3", { name: "s1", x: 40 }), mesa("s4", { name: " ", x: 60 })] }
    const messages = validateDraft(d).map((p) => p.message)
    expect(messages.some((m) => /^Hay dos mesas que se llaman «s1»\.$/i.test(m))).toBe(true)
    expect(messages).toContain("Hay una mesa sin nombre.")
  })

  it("avisa de zonas sin nombre o repetidas", () => {
    const d = addArea(addArea(base, "a", "sala"), "b", "")
    const messages = validateDraft(d).map((p) => p.message)
    expect(messages).toContain("Hay dos zonas que se llaman «sala».")
    expect(messages).toContain("Hay una zona sin nombre.")
  })

  it("avisa de mesas en zonas que no existen", () => {
    const d: PlanoDraft = { ...base, tables: [mesa("x", { areaId: "nada" })] }
    expect(validateDraft(d).map((p) => p.message)).toContain("La mesa X está en una zona que no existe.")
  })
})

describe("qué se guarda", () => {
  it("sin cambios no hay nada que escribir", () => {
    expect(countChanges(diffDraft(base, base))).toBe(0)
  })

  it("solo escribe los campos cambiados de cada mesa", () => {
    const d = setJoinable(moveTable(base, "s1", 6, 7), "s1", "s2", true)
    const c = diffDraft(base, d)
    expect(c.updateTables).toEqual([
      { id: "s1", data: { x: 6, y: 7, joinableWith: ["s2"] } },
      { id: "s2", data: { joinableWith: ["s1"] } },
    ])
    expect(c.createTables).toEqual([])
  })

  it("el orden de joinableWith no cuenta como cambio", () => {
    const saved: PlanoDraft = { ...base, tables: [mesa("a", { joinableWith: ["c", "b"] })] }
    const d: PlanoDraft = { ...base, tables: [mesa("a", { joinableWith: ["b", "c"] })] }
    expect(diffDraft(saved, d).updateTables).toEqual([])
  })

  it("altas y bajas de mesas y zonas", () => {
    const d = deleteTable(addTable(addArea(base, "patio", "  Patio "), "patio", "p1"), "t1")
    const c = diffDraft(base, d)
    expect(c.createAreas).toEqual([{ id: "patio", data: { name: "Patio", sortOrder: 2 } }])
    expect(c.createTables.map((t) => t.id)).toEqual(["p1"])
    expect(c.createTables[0]?.data).toMatchObject({ name: "P1", areaId: "patio" })
    expect(c.deleteTables).toEqual(["t1"])
    expect(countChanges(c)).toBe(3)
  })
})
