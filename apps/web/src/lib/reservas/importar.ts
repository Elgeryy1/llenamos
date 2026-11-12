/**
 * Importar reservas desde una hoja de cálculo: CSV o Excel (`.xlsx`).
 *
 * - Lee el `.xlsx` de Excel sin dependencias (primera hoja, ver `xlsx.ts`).
 * - Lee el CSV que guarda Excel en castellano (separado por «;», en Windows 1252) y el
 *   CSV UTF-8 (con o sin BOM, separado por «,» o «;»), con comillas y saltos de línea
 *   dentro de las celdas.
 * - Reconoce las columnas por su nombre en castellano o en inglés.
 * - Valida cada fila con `parseImportRow` de core, el mismo esquema que usa
 *   `importarReservas` en el servidor, para enseñar los errores antes de enviar.
 *
 * `.xls` (el formato antiguo), `.ods` y `.numbers` no se leen: se pide guardarlos como `.xlsx` o CSV.
 */
import { IMPORT_MAX_ROWS, parseImportRow, type ImportRow, type ImportRowError } from "@llenamos/core"
import { fold } from "./estados"
import { looksLikeZip, readXlsx, XlsxError } from "./xlsx"

/* Texto del archivo ---------------------------------------------------------- */

/** UTF-8 si el archivo lo es; si no, Windows 1252 (lo que guarda Excel en «CSV delimitado»). */
export function decodeCsv(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(view).replace(/^﻿/, "")
  } catch {
    return new TextDecoder("windows-1252").decode(view)
  }
}

/** Separador más probable mirando la primera línea (fuera de comillas). */
export function detectDelimiter(text: string): "," | ";" | "\t" {
  const counts = { ",": 0, ";": 0, "\t": 0 }
  let quoted = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && (ch === "\n" || ch === "\r")) break
    else if (!quoted && ch in counts) counts[ch as keyof typeof counts] += 1
  }
  if (counts[";"] >= counts[","] && counts[";"] >= counts["\t"] && counts[";"] > 0) return ";"
  if (counts["\t"] > counts[","]) return "\t"
  return ","
}

/** Filas y celdas de un CSV (RFC 4180: comillas dobles, «""» dentro de comillas, saltos dentro de celdas). */
export function parseCsv(text: string, delimiter = detectDelimiter(text)): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === "") quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ""
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ""
    } else cell += ch
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  // Fuera las líneas vacías (Excel deja «;;;;» al final a veces).
  return rows.filter((r) => r.some((c) => c.trim() !== ""))
}

/* Columnas ------------------------------------------------------------------- */

/** Campos que entiende `ImportRowSchema`. */
export const IMPORT_FIELDS = [
  "guestName",
  "phone",
  "email",
  "date",
  "time",
  "partySize",
  "durationMinutes",
  "status",
  "language",
  "notes",
  "tables",
] as const
export type ImportField = (typeof IMPORT_FIELDS)[number]

export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  guestName: "Nombre",
  phone: "Teléfono",
  email: "Correo",
  date: "Fecha",
  time: "Hora",
  partySize: "Personas",
  durationMinutes: "Duración",
  status: "Estado",
  language: "Idioma",
  notes: "Notas",
  tables: "Mesas",
}

export const REQUIRED_FIELDS: readonly ImportField[] = ["guestName", "phone", "date", "time", "partySize"]

/** Nombres de columna que se reconocen (ya sin acentos ni mayúsculas). */
const ALIASES: Record<ImportField, readonly string[]> = {
  guestName: ["nombre", "cliente", "nombre del cliente", "nombre y apellidos", "name", "guest", "guestname", "guest name"],
  phone: ["telefono", "tel", "tlf", "movil", "phone", "mobile", "whatsapp"],
  email: ["correo", "email", "e-mail", "mail", "correo electronico"],
  date: ["fecha", "dia", "date", "day"],
  time: ["hora", "time", "hora de llegada"],
  partySize: ["personas", "comensales", "pax", "cubiertos", "partysize", "party size", "guests", "people"],
  durationMinutes: ["duracion", "minutos", "duracion (min)", "duration", "durationminutes", "minutes"],
  status: ["estado", "status"],
  language: ["idioma", "language", "lang"],
  notes: ["notas", "nota", "observaciones", "comentarios", "notes", "comments"],
  tables: ["mesa", "mesas", "table", "tables"],
}

/** Qué campo es cada columna (null si no se reconoce y se ignora). */
export function mapHeaders(headers: readonly string[]): Array<ImportField | null> {
  const used = new Set<ImportField>()
  return headers.map((h) => {
    const key = fold(h).replace(/\s+/g, " ")
    const field = IMPORT_FIELDS.find((f) => !used.has(f) && (f.toLowerCase() === key || ALIASES[f].includes(key)))
    if (!field) return null
    used.add(field)
    return field
  })
}

/* Vista previa ---------------------------------------------------------------- */

export interface PreviewRow {
  /** Posición entre las filas de datos, empezando por 0. */
  index: number
  /** Línea de la hoja (la cabecera es la 1). */
  line: number
  raw: Partial<Record<ImportField, string>>
  value: ImportRow | null
  errors: ImportRowError[]
}

export interface ImportPreview {
  /** Columnas tal cual vienen y qué campo es cada una. */
  columns: Array<{ header: string; field: ImportField | null }>
  missingFields: ImportField[]
  rows: PreviewRow[]
  valid: number
  invalid: number
  /** Errores del archivo entero (vacío, sin cabecera, demasiadas filas). */
  problems: string[]
}

export function previewImport(text: string): ImportPreview {
  return previewImportTable(parseCsv(text))
}

/** Vista previa de una tabla ya leída (de un CSV o de la primera hoja de un `.xlsx`). */
export function previewImportTable(table: readonly string[][]): ImportPreview {
  const [header, ...data] = table
  if (!header) {
    return { columns: [], missingFields: [...REQUIRED_FIELDS], rows: [], valid: 0, invalid: 0, problems: ["El archivo está vacío."] }
  }
  const fields = mapHeaders(header)
  const columns = header.map((h, i) => ({ header: h.trim(), field: fields[i] ?? null }))
  const missingFields = REQUIRED_FIELDS.filter((f) => !fields.includes(f))
  const problems: string[] = []
  if (missingFields.length > 0) {
    problems.push(`Faltan columnas: ${missingFields.map((f) => IMPORT_FIELD_LABEL[f].toLowerCase()).join(", ")}. La primera fila debe tener los nombres de las columnas.`)
  }
  if (data.length === 0) problems.push("No hay filas de reservas debajo de la cabecera.")
  if (data.length > IMPORT_MAX_ROWS * 10) problems.push(`Demasiadas filas: como mucho ${IMPORT_MAX_ROWS * 10} por archivo.`)

  const rows: PreviewRow[] = data.slice(0, IMPORT_MAX_ROWS * 10).map((cells, index) => {
    const raw: Partial<Record<ImportField, string>> = {}
    fields.forEach((field, i) => {
      if (field) raw[field] = (cells[i] ?? "").trim().slice(0, 1000)
    })
    const parsed = parseImportRow(raw, index)
    return parsed.ok
      ? { index, line: index + 2, raw, value: parsed.value, errors: [] }
      : { index, line: index + 2, raw, value: null, errors: parsed.errors }
  })
  const valid = rows.filter((r) => r.value !== null).length
  return { columns, missingFields, rows, valid, invalid: rows.length - valid, problems }
}

/** Error al leer el archivo, con un mensaje para enseñar. */
export class ImportFileError extends Error {}

/** Hojas que no se leen y se piden en otro formato. */
const OTHER_SPREADSHEETS = /\.(xls|xlsb|ods|numbers)$/i

/**
 * Lee el archivo que se sube: `.xlsx` (también si solo lo delata su contenido) o CSV.
 * Lanza `ImportFileError` con un mensaje para enseñar si no se puede leer.
 */
export async function readImportFile(name: string, bytes: ArrayBuffer | Uint8Array): Promise<ImportPreview> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (OTHER_SPREADSHEETS.test(name)) {
    throw new ImportFileError("Ese tipo de hoja de cálculo no se puede leer. En Excel o Numbers: Archivo, Guardar como, «Libro de Excel (.xlsx)» o «CSV UTF-8», y súbelo otra vez.")
  }
  if (/\.xlsx$/i.test(name) || looksLikeZip(view)) {
    try {
      return previewImportTable(await readXlsx(view))
    } catch (e) {
      throw new ImportFileError(e instanceof XlsxError ? e.message : "No se ha podido leer el archivo de Excel. Guárdalo como CSV y súbelo otra vez.")
    }
  }
  return previewImport(decodeCsv(view))
}

/** Filas listas para `importarReservas` en tandas de como mucho 500, con su posición en la vista previa. */
export function importBatches(rows: readonly PreviewRow[], size = IMPORT_MAX_ROWS): Array<{ indexes: number[]; rows: Array<Record<string, string>> }> {
  const valid = rows.filter((r) => r.value !== null)
  const out: Array<{ indexes: number[]; rows: Array<Record<string, string>> }> = []
  for (let i = 0; i < valid.length; i += size) {
    const chunk = valid.slice(i, i + size)
    out.push({
      indexes: chunk.map((r) => r.index),
      rows: chunk.map((r) => Object.fromEntries(Object.entries(r.raw).filter(([, v]) => v !== undefined && v !== ""))),
    })
  }
  return out
}

/** Pasa los errores de una tanda (posición dentro de la tanda) a la posición en la vista previa. */
export function remapErrors(errors: readonly ImportRowError[], indexes: readonly number[]): ImportRowError[] {
  return errors.map((e) => ({ ...e, row: indexes[e.row] ?? e.row }))
}

/** CSV de ejemplo para descargar. */
export const SAMPLE_CSV = [
  "Nombre;Teléfono;Correo;Fecha;Hora;Personas;Estado;Mesa;Notas",
  "Ana García;612 345 678;ana@example.com;9/11/2026;13:30;2;confirmada;S1;Ventana",
  "Joan Puig;+34 699 111 222;;9/11/2026;21:00;4;;;Cumpleaños",
].join("\r\n")
