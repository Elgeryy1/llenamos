import { describe, expect, it } from "vitest"
import { decodeCsv, detectDelimiter, importBatches, mapHeaders, parseCsv, previewImport, remapErrors, SAMPLE_CSV } from "./importar"

describe("leer el CSV", () => {
  it("detecta punto y coma (Excel en castellano), coma y tabulador", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";")
    expect(detectDelimiter("a,b,c")).toBe(",")
    expect(detectDelimiter("a\tb\tc")).toBe("\t")
    expect(detectDelimiter('"a;b",c,d')).toBe(",")
  })

  it("entiende comillas, comillas dobles y saltos dentro de una celda", () => {
    expect(parseCsv('nombre;notas\r\n"Puig; Joan";"dice ""hola""\ny adiós"\r\n')).toEqual([
      ["nombre", "notas"],
      ["Puig; Joan", 'dice "hola"\ny adiós'],
    ])
  })

  it("ignora las líneas vacías", () => {
    expect(parseCsv("a;b\n;\n\n1;2\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ])
  })

  it("lee UTF-8 con BOM y el Windows 1252 de Excel", () => {
    const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("Núria")])
    expect(decodeCsv(utf8)).toBe("Núria")
    // «Núria» en Windows 1252: la ú es 0xFA.
    expect(decodeCsv(new Uint8Array([0x4e, 0xfa, 0x72, 0x69, 0x61]))).toBe("Núria")
  })
})

describe("columnas", () => {
  it("reconoce nombres en castellano con acentos y en inglés", () => {
    expect(mapHeaders(["Nombre", "Teléfono", "E-mail", "Día", "HORA", "Pax", "Observaciones", "Mesa", "Otra"])).toEqual([
      "guestName",
      "phone",
      "email",
      "date",
      "time",
      "partySize",
      "notes",
      "tables",
      null,
    ])
  })

  it("no asigna dos columnas al mismo campo", () => {
    expect(mapHeaders(["nombre", "cliente"])).toEqual(["guestName", null])
  })
})

describe("vista previa", () => {
  it("el CSV de ejemplo es válido", () => {
    const p = previewImport(SAMPLE_CSV)
    expect(p.problems).toEqual([])
    expect(p.valid).toBe(2)
    expect(p.rows[0]?.value).toMatchObject({ guestName: "Ana García", phone: "+34612345678", date: "2026-11-09", time: "13:30", partySize: 2, tables: ["S1"] })
    expect(p.rows[1]?.value).toMatchObject({ status: "confirmed", email: null })
  })

  it("da los errores de cada fila y campo, con su línea de la hoja", () => {
    const p = previewImport("nombre;telefono;fecha;hora;personas\nAna;612345678;31/02/2026;13:30;2\n;abc;9/11/2026;25:00;cero")
    expect(p.valid).toBe(0)
    expect(p.invalid).toBe(2)
    expect(p.rows[0]).toMatchObject({ line: 2, errors: [{ row: 0, field: "date" }] })
    expect(p.rows[1]?.errors.map((e) => e.field).sort()).toEqual(["guestName", "partySize", "phone", "time"])
  })

  it("avisa si faltan columnas obligatorias", () => {
    const p = previewImport("nombre;hora\nAna;13:00")
    expect(p.missingFields).toEqual(["phone", "date", "partySize"])
    expect(p.problems[0]).toContain("teléfono, fecha, personas")
  })

  it("un archivo vacío se dice", () => {
    expect(previewImport("").problems).toEqual(["El archivo está vacío."])
  })
})

describe("envío por tandas", () => {
  it("solo manda las filas válidas, sin celdas vacías, y recoloca los errores del servidor", () => {
    const p = previewImport("nombre;telefono;fecha;hora;personas;notas\nAna;612345678;9/11/2026;13:30;2;\nMal;x;x;x;x;\nJoan;699111222;9/11/2026;14:00;4;tarta")
    const batches = importBatches(p.rows, 1)
    expect(batches.map((b) => b.indexes)).toEqual([[0], [2]])
    expect(batches[0]?.rows[0]).toEqual({ guestName: "Ana", phone: "612345678", date: "9/11/2026", time: "13:30", partySize: "2" })
    expect(remapErrors([{ row: 0, field: null, message: "No queda sitio." }], batches[1]!.indexes)).toEqual([{ row: 2, field: null, message: "No queda sitio." }])
  })
})
