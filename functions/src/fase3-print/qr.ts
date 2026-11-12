// Adaptación propia del codificador de carta. QR modelo 2 V11 M, máscara 0.
/** QR modelo 2, versión 11, corrección M, modo byte y máscara 0. No envía el enlace a servicios externos. */
export function qrMatrix(value: string): boolean[][] {
  const bytes = new TextEncoder().encode(value)
  if (bytes.length > 251) throw new Error("El enlace es demasiado largo para este QR. Usa un origen más corto.")
  const bits: number[] = []
  const push = (n: number, count: number) => {
    for (let i = count - 1; i >= 0; i--) bits.push((n >>> i) & 1)
  }
  push(4, 4)
  push(bytes.length, 16)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, 254 * 8 - bits.length))
  while (bits.length % 8) bits.push(0)
  const data: number[] = []
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0))
  for (let i = 0; data.length < 254; i++) data.push(i % 2 ? 0x11 : 0xec)
  const mul = (a: number, b: number) => {
    let x = 0
    for (; b; b >>>= 1) {
      if (b & 1) x ^= a
      a <<= 1
      if (a & 256) a ^= 0x11d
    }
    return x
  }
  let poly = [1],
    power = 1
  for (let i = 0; i < 30; i++) {
    const next = Array<number>(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] = next[j]! ^ poly[j]!
      next[j + 1] = next[j + 1]! ^ mul(poly[j]!, power)
    }
    poly = next
    power = mul(power, 2)
  }
  let offset = 0
  const blocks = [50, 51, 51, 51, 51].map((size) => {
    const d = data.slice(offset, offset + size)
    offset += size
    const remainder = [...d, ...Array<number>(30).fill(0)]
    for (let i = 0; i < d.length; i++) {
      const n = remainder[i]!
      for (let j = 0; j < poly.length; j++) remainder[i + j] = remainder[i + j]! ^ mul(poly[j]!, n)
    }
    return { d, e: remainder.slice(-30) }
  })
  const code: number[] = []
  for (let i = 0; i < 51; i++) for (const b of blocks) if (i < b.d.length) code.push(b.d[i]!)
  for (let i = 0; i < 30; i++) for (const b of blocks) code.push(b.e[i]!)
  const size = 61,
    grid = Array.from({ length: size }, () => Array<boolean>(size).fill(false)),
    fixed = Array.from({ length: size }, () => Array<boolean>(size).fill(false))
  const put = (x: number, y: number, dark: boolean) => {
    if (x >= 0 && x < size && y >= 0 && y < size) {
      grid[y]![x] = dark
      fixed[y]![x] = true
    }
  }
  for (const [cx, cy] of [
    [3, 3],
    [57, 3],
    [3, 57],
  ] as const)
    for (let y = -4; y <= 4; y++)
      for (let x = -4; x <= 4; x++) {
        const d = Math.max(Math.abs(x), Math.abs(y))
        put(cx + x, cy + y, d !== 2 && d !== 4)
      }
  for (const cy of [6, 30, 54])
    for (const cx of [6, 30, 54]) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === 54) || (cx === 54 && cy === 6)) continue
      for (let y = -2; y <= 2; y++)
        for (let x = -2; x <= 2; x++) put(cx + x, cy + y, Math.max(Math.abs(x), Math.abs(y)) !== 1)
    }
  for (let i = 8; i < size - 8; i++) {
    if (!fixed[6]![i]) put(i, 6, i % 2 === 0)
    if (!fixed[i]![6]) put(6, i, i % 2 === 0)
  }
  // Información BCH de formato: nivel M (00), máscara 0 (000).
  let format = 0
  for (let i = 14; i >= 10; i--) if ((format >>> i) & 1) format ^= 0x537 << (i - 10)
  format = format ^ 0x5412
  const bit = (n: number, i: number) => ((n >>> i) & 1) !== 0
  for (let i = 0; i <= 5; i++) put(8, i, bit(format, i))
  put(8, 7, bit(format, 6))
  put(8, 8, bit(format, 7))
  put(7, 8, bit(format, 8))
  for (let i = 9; i < 15; i++) put(14 - i, 8, bit(format, i))
  for (let i = 0; i < 8; i++) put(size - 1 - i, 8, bit(format, i))
  for (let i = 8; i < 15; i++) put(8, size - 15 + i, bit(format, i))
  put(8, size - 8, true)
  let version = 11 << 12
  for (let i = 17; i >= 12; i--) if ((version >>> i) & 1) version ^= 0x1f25 << (i - 12)
  version |= 11 << 12
  for (let i = 0; i < 18; i++) {
    const a = size - 11 + (i % 3),
      b = Math.floor(i / 3)
    put(a, b, bit(version, i))
    put(b, a, bit(version, i))
  }
  let index = 0,
    up = true
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right--
    for (let row = 0; row < size; row++) {
      const y = up ? size - 1 - row : row
      for (let dx = 0; dx < 2; dx++) {
        const x = right - dx
        if (fixed[y]![x]) continue
        const dark = index < code.length * 8 && bit(code[index >>> 3]!, 7 - (index % 8))
        grid[y]![x] = dark !== ((x + y) % 2 === 0)
        index++
      }
    }
    up = !up
  }
  return grid
}
