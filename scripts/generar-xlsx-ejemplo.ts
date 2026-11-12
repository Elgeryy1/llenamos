/**
 * Genera los `.xlsx` de ejemplo de `tests/fixtures/` para las pruebas de importar.
 *
 *   pnpm fixtures:xlsx
 *
 * Se escriben a mano (zip + XML) para que la prueba no dependa de ninguna librería de
 * Excel y cubra lo que hace Excel de verdad: cadenas compartidas con formato, texto en
 * línea, fechas y horas como números de serie con formatos propios y de serie, celdas
 * que faltan, una fila vacía, una fórmula, la primera hoja en otro archivo que
 * `sheet1.xml`, un archivo guardado sin comprimir y el sistema de fechas de 1904 de Mac.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { deflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Zip mínimo: cabeceras locales, directorio central y final. `store` guarda sin comprimir. */
function zip(files: Array<{ name: string; text: string; store?: boolean }>): Buffer {
  const locals: Buffer[] = [], centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8'), raw = Buffer.from(file.text, 'utf8')
    const data = file.store ? raw : deflateRawSync(raw)
    const method = file.store ? 0 : 8, crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(name.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, name, data); centrals.push(central, name)
    offset += 30 + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const DAY = 86_400_000
/** Número de serie de Excel de una fecha (sistema de 1900 o de 1904). */
const serial = (y: number, m: number, d: number, date1904: boolean) =>
  (Date.UTC(y, m - 1, d) - Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 30)) / DAY

function workbook(date1904: boolean): Buffer {
  const shared = ['Nombre', 'Teléfono', 'Correo', 'Fecha', 'Hora', 'Personas', 'Estado', 'Mesa', 'Notas', 'Ana García', 'ana@example.com', 'confirmada', 'S1', '+34 699 111 222', 'Núria Vidal', '600 000 003', '10/11/2026', '21:30']
  const si = shared.map(s => `<si><t>${s.replace(/&/g, '&amp;')}</t></si>`).join('')
  // Texto con dos tramos de formato, una entidad y la guía fonética que no se debe leer.
  const rich = '<si><r><rPr><b/></rPr><t>Ventana </t></r><r><t xml:space="preserve">&amp; terraza</t></r><rPh sb="0" eb="1"><t>ベ</t></rPh></si>'
  const s = (i: number) => `t="s"><v>${i}</v></c>`
  const sheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>
<row r="1">${shared.slice(0, 9).map((_, i) => `<c r="${String.fromCharCode(65 + i)}1" ${s(i)}`).join('')}</row>
<row r="2"><c r="A2" ${s(9)}<c r="B2"><v>612345678</v></c><c r="C2" ${s(10)}<c r="D2" s="1"><v>${serial(2026, 11, 9, date1904)}</v></c><c r="E2" s="2"><v>0.5625</v></c><c r="F2"><v>2</v></c><c r="G2" ${s(11)}<c r="H2" ${s(12)}<c r="I2" t="s"><v>${shared.length}</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Joan Puig</t></is></c><c r="B3" ${s(13)}<c r="D3" s="3"><v>${serial(2026, 11, 10, date1904)}</v></c><c r="E3" s="4"><v>0.875</v></c><c r="F3" s="5"><v>4</v></c><c r="I3" t="inlineStr"><is><t xml:space="preserve"> Cumpleaños </t></is></c></row>
<row r="4"/>
<row r="5"><c r="A5" ${s(14)}<c r="B5" ${s(15)}<c r="C5"/><c r="D5" ${s(16)}<c r="E5" ${s(17)}<c r="F5" t="str"><f>3*2</f><v>6</v></c></row>
</sheetData></worksheet>`
  const otherSheet = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Esta hoja no se lee</t></is></c></row></sheetData></worksheet>`
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy;@"/><numFmt numFmtId="165" formatCode="[$-es-ES]hh:mm"/></numFmts>
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="6"><xf numFmtId="0" fontId="0"/><xf numFmtId="14" fontId="0" applyNumberFormat="1"/><xf numFmtId="20" fontId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`
  return zip([
    { name: '[Content_Types].xml', store: true, text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/hoja-reservas.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>` },
    { name: '_rels/.rels', text: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>' },
    { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr${date1904 ? ' date1904="1"' : ''}/><sheets><sheet name="Reservas" sheetId="2" r:id="rId2"/><sheet name="Notas" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/hoja-reservas.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>` },
    { name: 'xl/worksheets/sheet1.xml', text: otherSheet },
    { name: 'xl/worksheets/hoja-reservas.xml', text: sheet },
    { name: 'xl/sharedStrings.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length + 1}" uniqueCount="${shared.length + 1}">${si}${rich}</sst>` },
    { name: 'xl/styles.xml', text: styles },
  ])
}

const dir = fileURLToPath(new URL('../tests/fixtures/', import.meta.url))
mkdirSync(dir, { recursive: true })
writeFileSync(`${dir}reservas-ejemplo.xlsx`, workbook(false))
writeFileSync(`${dir}reservas-1904.xlsx`, workbook(true))
console.log('Escritos tests/fixtures/reservas-ejemplo.xlsx y tests/fixtures/reservas-1904.xlsx')
