/**
 * Exportación de informes a CSV para Excel (fase 5): separador punto y coma, coma decimal en los
 * importes, fin de línea CRLF y marca BOM al principio. No es una copia de seguridad ni la
 * exportación de datos personales de la fase 6: solo cifras, sin contactos de clientes.
 */
export const CSV_BOM = "﻿"

export type CsvCell = string | number | null
export type CsvColumn<T> = { header: string; value: (row: T) => CsvCell; kind?: "text" | "integer" | "cents" | "bp" }

function cell(v: CsvCell, kind: CsvColumn<unknown>["kind"]): string {
  if (v === null) return ""
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("Las cifras de la exportación deben ser enteras.")
    if (kind === "cents" || kind === "bp") {
      const sign = v < 0 ? "-" : ""
      const abs = Math.abs(v)
      return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`
    }
    return String(v)
  }
  // Evita que Excel interprete fórmulas en textos (inyección de CSV).
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v
  return /[;"\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

/** CSV con cabecera. `cents` sale en euros con coma decimal; `bp` en porcentaje con coma. */
export function toCsv<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): string {
  const lines = [columns.map((c) => cell(c.header, "text")).join(";")]
  for (const r of rows) lines.push(columns.map((c) => cell(c.value(r), c.kind)).join(";"))
  return CSV_BOM + lines.join("\r\n") + "\r\n"
}

/** Nombre de archivo sin caracteres raros. */
export function csvFilename(kind: string, from: string, to: string): string {
  return `llenamos-${kind}-${from}-${to}.csv`.replace(/[^a-z0-9._-]/gi, "-")
}
