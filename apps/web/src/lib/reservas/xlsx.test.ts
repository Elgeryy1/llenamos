import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { deflateRawSync } from "node:zlib"
import { describe, expect, it } from "vitest"
import { ImportFileError, readImportFile } from "./importar"
import { decodeXmlText, excelSerialToText, formatKind, looksLikeZip, readXlsx, XlsxError } from "./xlsx"

/** Los `.xlsx` de ejemplo los genera `pnpm fixtures:xlsx` (scripts/generar-xlsx-ejemplo.ts). */
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(process.cwd(), "../../tests/fixtures", name)))

/** Zip mínimo deliberadamente sin CRC: permite probar tamaños falsos y XML hostil. */
function zip(files: Array<[string, Buffer, number?]>): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const [path, raw, declaredSize = raw.length] of files) {
    const name = Buffer.from(path), data = deflateRawSync(raw)
    const header = Buffer.alloc(30), entry = Buffer.alloc(46)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(8, 8); header.writeUInt16LE(name.length, 26)
    entry.writeUInt32LE(0x02014b50); entry.writeUInt16LE(8, 10); entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(declaredSize, 24); entry.writeUInt16LE(name.length, 28); entry.writeUInt32LE(offset, 42)
    local.push(header, name, data); central.push(entry, name)
    offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

const ESPERADO = [
  ["Nombre", "Teléfono", "Correo", "Fecha", "Hora", "Personas", "Estado", "Mesa", "Notas"],
  ["Ana García", "612345678", "ana@example.com", "2026-11-09", "13:30", "2", "confirmada", "S1", "Ventana & terraza"],
  ["Joan Puig", "+34 699 111 222", "", "2026-11-10", "21:00", "4", "", "", " Cumpleaños "],
  ["Núria Vidal", "600 000 003", "", "10/11/2026", "21:30", "6"],
]

describe("readXlsx", () => {
  it("lee la primera hoja del libro (no la sheet1.xml), con textos, números, fechas y horas", async () => {
    expect(await readXlsx(fixture("reservas-ejemplo.xlsx"))).toEqual(ESPERADO)
  })

  it("da lo mismo con el sistema de fechas de 1904 de Mac", async () => {
    expect(await readXlsx(fixture("reservas-1904.xlsx"))).toEqual(ESPERADO)
  })

  it("rechaza lo que no es un Excel", async () => {
    await expect(readXlsx(new TextEncoder().encode("nombre;hora\nAna;13:30"))).rejects.toBeInstanceOf(XlsxError)
    await expect(readXlsx(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]))).rejects.toBeInstanceOf(XlsxError)
    // Un zip sin libro dentro.
    const sinLibro = fixture("reservas-ejemplo.xlsx").slice(0, 60)
    await expect(readXlsx(sinLibro)).rejects.toBeInstanceOf(XlsxError)
  })

  it("rechaza directorios truncados, tamaños falsos y libros protegidos", async () => {
    const bytes = fixture("reservas-ejemplo.xlsx")
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    view.setUint32(bytes.length - 6, bytes.length + 100, true)
    await expect(readXlsx(bytes)).rejects.toBeInstanceOf(XlsxError)
    await expect(readXlsx(zip([["xl/workbook.xml", Buffer.from("<workbook/>"), 1]]))).rejects.toBeInstanceOf(XlsxError)
    const encrypted = zip([["xl/workbook.xml", Buffer.from("<workbook/>")]])
    const ev = new DataView(encrypted.buffer, encrypted.byteOffset, encrypted.byteLength)
    ev.setUint16(ev.getUint32(encrypted.length - 6, true) + 8, 1, true)
    await expect(readXlsx(encrypted)).rejects.toThrow(/contraseña/)
  })

  it("corta la descompresión aunque el zip declare un tamaño pequeño", async () => {
    const bomb = zip([["xl/workbook.xml", Buffer.alloc(51 * 1024 * 1024, 32), 1]])
    await expect(readXlsx(bomb)).rejects.toThrow(/demasiado grande/)
  })

  it("rechaza columnas fuera del límite de Excel sin intentar rellenarlas", async () => {
    const bytes = zip([
      ["xl/workbook.xml", Buffer.from("<workbook/>")],
      ["xl/worksheets/sheet1.xml", Buffer.from('<worksheet><row><c r="ZZZZZZ1"><v>1</v></c></row></worksheet>')],
    ])
    await expect(readXlsx(bytes)).rejects.toThrow(/demasiadas columnas/)
  })
})

describe("zip y XML", () => {
  it("reconoce un zip por su cabecera", () => {
    expect(looksLikeZip(fixture("reservas-ejemplo.xlsx"))).toBe(true)
    expect(looksLikeZip(new TextEncoder().encode("a;b"))).toBe(false)
  })

  it("decodifica entidades y los caracteres de control de Excel", () => {
    expect(decodeXmlText("Tom &amp; Jerry &lt;3 &#233; &#xE9;")).toBe("Tom & Jerry <3 é é")
    expect(decodeXmlText("a_x000D_b")).toBe("a\rb")
  })
})

describe("fechas y horas de Excel", () => {
  it("pasa el número de serie a fecha y hora de pared", () => {
    expect(excelSerialToText(46335, "date")).toBe("2026-11-09")
    expect(excelSerialToText(0.5625, "time")).toBe("13:30")
    expect(excelSerialToText(0.875, "time")).toBe("21:00")
    expect(excelSerialToText(46335.5625, "datetime")).toBe("2026-11-09 13:30")
  })

  it("no se come un minuto por la coma flotante", () => {
    expect(excelSerialToText(13.5 / 24, "time")).toBe("13:30")
    expect(excelSerialToText(20.25 / 24, "time")).toBe("20:15")
    expect(excelSerialToText(46335 + 19 / 24 + 45 / 1440, "datetime")).toBe("2026-11-09 19:45")
  })

  it("respeta el error de Excel con 1900 y el sistema de 1904", () => {
    expect(excelSerialToText(1, "date")).toBe("1900-01-01")
    expect(excelSerialToText(61, "date")).toBe("1900-03-01")
    expect(excelSerialToText(46335 - 1462, "date", true)).toBe("2026-11-09")
  })

  it("distingue formatos de fecha, de hora y de número", () => {
    expect(formatKind("dd/mm/yyyy;@")).toBe("date")
    expect(formatKind("[$-es-ES]hh:mm")).toBe("time")
    expect(formatKind("dd/mm/yyyy hh:mm")).toBe("datetime")
    expect(formatKind("[h]:mm:ss")).toBe("time")
    expect(formatKind("0.00")).toBe("number")
    expect(formatKind('0 "días"')).toBe("number")
    expect(formatKind("General")).toBe("number")
  })
})

describe("readImportFile", () => {
  it("convierte el Excel en una vista previa con las filas válidas", async () => {
    const preview = await readImportFile("reservas.xlsx", fixture("reservas-ejemplo.xlsx"))
    expect(preview.missingFields).toEqual([])
    expect(preview.rows).toHaveLength(3)
    expect(preview.valid).toBe(3)
    expect(preview.rows[0]?.value).toMatchObject({ guestName: "Ana García", date: "2026-11-09", time: "13:30", partySize: 2 })
  })

  it("lo detecta por el contenido aunque el nombre no acabe en .xlsx", async () => {
    const preview = await readImportFile("descarga", fixture("reservas-ejemplo.xlsx"))
    expect(preview.valid).toBe(3)
  })

  it("sigue leyendo CSV", async () => {
    const preview = await readImportFile("r.csv", new TextEncoder().encode("Nombre;Teléfono;Fecha;Hora;Personas\nAna;612345678;2026-11-09;13:30;2"))
    expect(preview.valid).toBe(1)
  })

  it("pide otro formato para .xls y .ods, y avisa si el Excel está dañado", async () => {
    await expect(readImportFile("a.xls", new Uint8Array([1]))).rejects.toBeInstanceOf(ImportFileError)
    await expect(readImportFile("a.ods", new Uint8Array([1]))).rejects.toBeInstanceOf(ImportFileError)
    await expect(readImportFile("a.xlsx", new Uint8Array([1, 2, 3]))).rejects.toThrow(/Excel/)
  })
})
