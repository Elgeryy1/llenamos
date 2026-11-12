/**
 * SHA-256 en TypeScript puro (FIPS 180-4), sin `node:crypto` ni `crypto.subtle`.
 *
 * Por qué aquí: core se usa igual en las funciones (Node) y en el navegador, y
 * `crypto.subtle` es asíncrono y no existe en todos los entornos de prueba. Los textos
 * que se cifran son cortos (ids, tokens), así que la velocidad no importa. Da el mismo
 * resultado que `createHash("sha256").update(texto, "utf8").digest("hex")` de Node, y
 * las pruebas lo comprueban con los vectores oficiales.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** Texto a bytes UTF-8 (sin `TextEncoder`, que no está en la librería ES2022). */
export function utf8Bytes(texto: string): Uint8Array {
  const bytes: number[] = []
  for (const caracter of texto) {
    // for…of recorre puntos de código, así que los emojis (pares sustitutos) llegan enteros.
    const c = caracter.codePointAt(0) ?? 0
    if (c < 0x80) bytes.push(c)
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f))
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 0x3f), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f))
  }
  return Uint8Array.from(bytes)
}

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))

/** Resumen SHA-256 de unos bytes (32 bytes). */
export function sha256(datos: Uint8Array): Uint8Array {
  const longitudBits = datos.length * 8
  // Mensaje + 0x80 + ceros + 8 bytes de longitud, hasta múltiplo de 64.
  const total = Math.ceil((datos.length + 9) / 64) * 64
  const bloque = new Uint8Array(total)
  bloque.set(datos)
  bloque[datos.length] = 0x80
  const vista = new DataView(bloque.buffer)
  vista.setUint32(total - 8, Math.floor(longitudBits / 0x1_0000_0000))
  vista.setUint32(total - 4, longitudBits >>> 0)

  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])
  const w = new Uint32Array(64)
  for (let inicio = 0; inicio < total; inicio += 64) {
    for (let i = 0; i < 16; i++) w[i] = vista.getUint32(inicio + i * 4)
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] ?? 0
      const w2 = w[i - 2] ?? 0
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3)
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10)
      w[i] = ((w[i - 16] ?? 0) + s0 + (w[i - 7] ?? 0) + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = [h[0] ?? 0, h[1] ?? 0, h[2] ?? 0, h[3] ?? 0, h[4] ?? 0, h[5] ?? 0, h[6] ?? 0, h[7] ?? 0]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + S1 + ch + (K[i] ?? 0) + (w[i] ?? 0)) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    const suma = [a, b, c, d, e, f, g, hh]
    for (let i = 0; i < 8; i++) h[i] = ((h[i] ?? 0) + (suma[i] ?? 0)) >>> 0
  }

  const salida = new Uint8Array(32)
  const vistaSalida = new DataView(salida.buffer)
  for (let i = 0; i < 8; i++) vistaSalida.setUint32(i * 4, h[i] ?? 0)
  return salida
}

/** Bytes a hexadecimal en minúsculas. */
export function toHex(bytes: Uint8Array): string {
  let hex = ""
  for (const b of bytes) hex += b.toString(16).padStart(2, "0")
  return hex
}

/** SHA-256 de un texto (UTF-8) en hexadecimal: 64 caracteres. Sirve para `manageTokenHash` y `offer.tokenHash`. */
export function sha256Hex(texto: string): string {
  return toHex(sha256(utf8Bytes(texto)))
}
