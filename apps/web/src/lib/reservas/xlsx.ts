/**
 * Leer la primera hoja de un `.xlsx` sin dependencias.
 *
 * Un `.xlsx` es un zip con XML dentro. Se lee el directorio central del zip, se
 * descomprimen solo los archivos que hacen falta con `DecompressionStream("deflate-raw")`
 * (navegador y Node 22) y se sacan las celdas de `xl/sharedStrings.xml` y de la primera
 * hoja del libro. Las fechas y horas de Excel (números de serie con formato de fecha) se
 * pasan a «2026-11-09» y «13:30», que es lo que entiende `parseImportRow`.
 *
 * No se calculan fórmulas: se usa el último valor que guardó Excel. No lee `.xls` (el
 * formato binario antiguo) ni `.ods`.
 */

/** Error con un mensaje que se puede enseñar tal cual. */
export class XlsxError extends Error {}

/** Tamaño máximo de un archivo descomprimido (para no colgar el navegador con un zip trampa). */
const MAX_ENTRY_BYTES = 50 * 1024 * 1024

/* Zip ------------------------------------------------------------------------ */

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  localOffset: number
}

function u16(b: Uint8Array, o: number): number {
  return (b[o] ?? 0) | ((b[o + 1] ?? 0) << 8)
}
function u32(b: Uint8Array, o: number): number {
  return (u16(b, o) | (u16(b, o + 2) << 16)) >>> 0
}

/** Es un zip si empieza por «PK\3\4». */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04
}

function zipEntries(b: Uint8Array): Map<string, ZipEntry> {
  // El final del directorio central está en los últimos 22 bytes más un comentario de hasta 64 KB.
  let end = -1
  for (let i = b.length - 22; i >= Math.max(0, b.length - 22 - 0xffff); i--) {
    if (u32(b, i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new XlsxError("El archivo no es un Excel válido o está dañado.")
  const count = u16(b, end + 10)
  let p = u32(b, end + 16)
  const directoryEnd = p + u32(b, end + 12)
  if (directoryEnd > end || u16(b, end + 4) || u16(b, end + 6)) throw new XlsxError("El archivo no es un Excel válido o está dañado.")
  const entries = new Map<string, ZipEntry>()
  const names = new TextDecoder("utf-8")
  for (let i = 0; i < count; i++) {
    if (p + 46 > directoryEnd || u32(b, p) !== 0x02014b50) throw new XlsxError("El archivo no es un Excel válido o está dañado.")
    const nameLength = u16(b, p + 28)
    const next = p + 46 + nameLength + u16(b, p + 30) + u16(b, p + 32)
    if (next > directoryEnd || (u16(b, p + 8) & 1)) throw new XlsxError("El archivo está dañado o protegido con contraseña. Guárdalo sin contraseña o como CSV.")
    const name = names.decode(b.subarray(p + 46, p + 46 + nameLength))
    entries.set(name, {
      name,
      method: u16(b, p + 10),
      compressedSize: u32(b, p + 20),
      size: u32(b, p + 24),
      localOffset: u32(b, p + 42),
    })
    p = next
  }
  return entries
}

async function inflateRaw(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") throw new XlsxError("Este navegador no puede leer archivos de Excel. Guárdalo como CSV.")
  const stream = new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      // Se comprueba mientras se descomprime: la medida declarada en el zip puede ser falsa.
      if (size > MAX_ENTRY_BYTES) throw new XlsxError("La hoja es demasiado grande. Divídela en varias.")
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  const output = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length }
  return output
}

async function readEntry(b: Uint8Array, entry: ZipEntry): Promise<string> {
  if (entry.size > MAX_ENTRY_BYTES) throw new XlsxError("La hoja es demasiado grande. Divídela en varias.")
  const o = entry.localOffset
  if (o + 30 > b.length || u32(b, o) !== 0x04034b50) throw new XlsxError("El archivo no es un Excel válido o está dañado.")
  const start = o + 30 + u16(b, o + 26) + u16(b, o + 28)
  if (start + entry.compressedSize > b.length) throw new XlsxError("El archivo no es un Excel válido o está dañado.")
  // Las medidas buenas son las del directorio central: con «data descriptor» la cabecera local va a cero.
  const raw = b.slice(start, start + entry.compressedSize)
  let data: Uint8Array
  if (entry.method === 0) data = raw
  else if (entry.method === 8) data = await inflateRaw(raw)
  else throw new XlsxError("El archivo usa una compresión que no se puede leer. Guárdalo como CSV.")
  if (data.length > MAX_ENTRY_BYTES) throw new XlsxError("La hoja es demasiado grande. Divídela en varias.")
  if (data.length !== entry.size) throw new XlsxError("El archivo no es un Excel válido o está dañado.")
  return new TextDecoder("utf-8").decode(data)
}

/* XML ------------------------------------------------------------------------ */

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }

/** Entidades XML y los «_x000D_» con los que Excel guarda caracteres de control. */
export function decodeXmlText(s: string): string {
  return s
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e: string) => {
      if (e[0] !== "#") return ENTITIES[e.toLowerCase()] ?? m
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : m
    })
    .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
}

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const key = m[1]!
    out[key] = decodeXmlText(m[3] ?? m[4] ?? "")
    // Sin prefijo también, para no depender de cómo se llame el espacio de nombres.
    const local = key.includes(":") ? key.slice(key.indexOf(":") + 1) : null
    if (local && !(local in out)) out[local] = out[key]!
  }
  return out
}

/** Texto de un bloque con `<t>` (celda en línea o cadena compartida), sin la guía fonética. */
function richText(xml: string): string {
  const clean = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")
  let text = ""
  for (const m of clean.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeXmlText(m[1] ?? "")
  return text
}

/* Fechas de Excel ------------------------------------------------------------ */

/** Formatos de fecha y hora que trae Excel sin definirlos en `styles.xml`. */
const BUILTIN_DATE = new Set([14, 15, 16, 17, 22, 27, 28, 29, 30, 31, 34, 35, 36, 50, 51, 52, 53, 54, 57, 58])
const BUILTIN_TIME = new Set([18, 19, 20, 21, 32, 33, 45, 46, 47, 55, 56])

export type CellKind = "number" | "date" | "time" | "datetime"

/** Qué enseña un código de formato: número, fecha, hora o fecha y hora. */
export function formatKind(code: string): CellKind {
  // Fuera lo que va entre comillas, los caracteres escapados y los colores o condiciones entre corchetes.
  const bare = code
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, "")
    .split(";")[0]!
    .toLowerCase()
  if (bare.trim() === "general" || bare.trim() === "@") return "number"
  const time = /[hs]/.test(bare) || /\[[hms]+\]/.test(bare)
  const date = /[dy]/.test(bare) || (/m/.test(bare) && !time)
  return date && time ? "datetime" : date ? "date" : time ? "time" : "number"
}

function builtinKind(id: number): CellKind {
  if (id === 22) return "datetime"
  if (BUILTIN_DATE.has(id)) return "date"
  if (BUILTIN_TIME.has(id)) return "time"
  return "number"
}

const DAY_MS = 86_400_000

/** Número de serie de Excel → «AAAA-MM-DD», «HH:MM» o los dos, en hora de pared (sin zonas). */
export function excelSerialToText(serial: number, kind: Exclude<CellKind, "number">, date1904 = false): string {
  // Se redondea al segundo para que 0,5625 dé 13:30 y no 13:29:59.
  let seconds = Math.round(serial * 86400)
  let days = Math.floor(seconds / 86400)
  seconds -= days * 86400
  let epoch: number
  if (date1904) epoch = Date.UTC(1904, 0, 1)
  else if (days >= 61) epoch = Date.UTC(1899, 11, 30)
  else {
    // Excel cree que 1900 fue bisiesto: el 60 es el «29 de febrero» que no existió.
    epoch = Date.UTC(1899, 11, 31)
    if (days === 60) days = 59
  }
  const d = new Date(epoch + days * DAY_MS)
  const pad = (n: number) => String(n).padStart(2, "0")
  const fecha = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const hora = `${pad(h)}:${pad(m)}${s ? `:${pad(s)}` : ""}`
  return kind === "date" ? fecha : kind === "time" ? hora : `${fecha} ${hora}`
}

/** Un número tal como se lee: enteros enteros y sin los restos de la coma flotante. */
function numberText(n: number): string {
  if (Number.isInteger(n)) return String(n)
  return String(Number.parseFloat(n.toPrecision(15)))
}

/* Libro ---------------------------------------------------------------------- */

function columnIndex(ref: string): number | null {
  const letters = /^([A-Z]+)\d*$/i.exec(ref)?.[1]
  if (!letters) return null
  let n = 0
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

function resolveTarget(target: string): string {
  if (target.startsWith("/")) return target.slice(1)
  const parts = ["xl"]
  for (const part of target.split("/")) {
    if (part === "..") parts.pop()
    else if (part && part !== ".") parts.push(part)
  }
  return parts.join("/")
}

/** Filas y celdas (como texto) de la primera hoja. Las filas vacías se quitan, como en el CSV. */
export async function readXlsx(input: ArrayBuffer | Uint8Array): Promise<string[][]> {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input)
  if (!looksLikeZip(bytes)) throw new XlsxError("El archivo no es un Excel (.xlsx) válido.")
  const entries = zipEntries(bytes)
  const read = async (name: string) => {
    const entry = entries.get(name)
    return entry ? readEntry(bytes, entry) : null
  }

  const workbook = await read("xl/workbook.xml")
  if (workbook === null) throw new XlsxError("El archivo no es un Excel (.xlsx) válido.")
  const date1904 = /<workbookPr\b[^>]*\bdate1904\s*=\s*["'](1|true)["']/i.test(workbook)

  // Primera hoja en el orden del libro, que no tiene por qué ser «sheet1.xml».
  let sheetPath = "xl/worksheets/sheet1.xml"
  const firstSheet = /<sheet\b[^>]*>/.exec(workbook)?.[0]
  const relId = firstSheet ? attributes(firstSheet).id : undefined
  const rels = await read("xl/_rels/workbook.xml.rels")
  if (relId && rels) {
    for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
      const a = attributes(m[0])
      if (a.Id === relId && a.Target) sheetPath = resolveTarget(a.Target)
    }
  }
  const sheet = await read(sheetPath)
  if (sheet === null) throw new XlsxError("El libro no tiene ninguna hoja.")

  const sharedXml = await read("xl/sharedStrings.xml")
  const shared = sharedXml ? [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)].map((m) => richText(m[1] ?? "")) : []

  // Estilo de cada celda (atributo «s») → formato de número → si es fecha u hora.
  const styles = await read("xl/styles.xml")
  const kinds: CellKind[] = []
  if (styles) {
    const custom = new Map<number, string>()
    for (const m of styles.matchAll(/<numFmt\b[^>]*>/g)) {
      const a = attributes(m[0])
      if (a.numFmtId && a.formatCode !== undefined) custom.set(Number(a.numFmtId), a.formatCode)
    }
    const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)?.[1] ?? ""
    for (const m of xfs.matchAll(/<xf\b[^>]*>/g)) {
      const id = Number(attributes(m[0]).numFmtId ?? 0)
      const code = custom.get(id)
      kinds.push(code !== undefined ? formatKind(code) : builtinKind(id))
    }
  }

  const rows: string[][] = []
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const row: string[] = []
    let next = 0
    for (const c of (rowMatch[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const a = attributes(c[1] ?? "")
      const col = a.r ? (columnIndex(a.r) ?? next) : next
      if (col >= 16384) throw new XlsxError("La hoja tiene demasiadas columnas. Deja solo las columnas de reservas.")
      next = col + 1
      const body = c[2] ?? ""
      const v = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(body)?.[1]
      let text = ""
      switch (a.t) {
        case "s":
          text = shared[Number(v)] ?? ""
          break
        case "inlineStr":
          text = richText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? "")
          break
        case "str":
        case "e":
          text = decodeXmlText(v ?? "")
          break
        case "b":
          text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : ""
          break
        case "d":
          text = decodeXmlText(v ?? "").replace("T", " ").replace(/(\d{2}:\d{2})(:00)?(\.\d+)?Z?$/, "$1")
          break
        default: {
          if (v === undefined || v.trim() === "") break
          const n = Number(v)
          if (!Number.isFinite(n)) {
            text = decodeXmlText(v)
            break
          }
          const kind = kinds[Number(a.s ?? 0)] ?? "number"
          text = kind === "number" ? numberText(n) : excelSerialToText(n, kind, date1904)
        }
      }
      while (row.length < col) row.push("")
      row[col] = text
    }
    if (row.some((cell) => cell.trim() !== "")) rows.push(row)
  }
  return rows
}
