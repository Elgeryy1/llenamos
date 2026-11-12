import { describe, expect, it } from "vitest"
import {
  customerIdFor,
  InvalidPhoneError,
  linkToken,
  normalizePhone,
  normalizeReference,
  PhoneInputSchema,
  REFERENCE_ALPHABET,
  reservationReference,
  ReservationReferenceInputSchema,
  sha256Hex,
  TimestampSchema,
  timestampToMillis,
  tryNormalizePhone,
  utf8Bytes,
} from "./index"

/** Bytes de prueba deterministas (no aleatorios). */
function bytes(...valores: number[]): Uint8Array {
  return Uint8Array.from(valores)
}

describe("marcas de tiempo", () => {
  const ms = Date.UTC(2026, 10, 9, 12, 30)

  /** Imita un Timestamp de Firestore (web o admin) sin depender de Firebase. */
  class TimestampFalso {
    constructor(
      readonly seconds: number,
      readonly nanoseconds: number,
    ) {}
    toMillis() {
      return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6)
    }
  }

  it("acepta ms, Date, Timestamp y sus formas JSON, y devuelve ms", () => {
    expect(TimestampSchema.parse(ms)).toBe(ms)
    expect(TimestampSchema.parse(new Date(ms))).toBe(ms)
    expect(TimestampSchema.parse(new TimestampFalso(ms / 1000, 0))).toBe(ms)
    expect(TimestampSchema.parse({ seconds: ms / 1000, nanoseconds: 250_000_000 })).toBe(ms + 250)
    expect(TimestampSchema.parse({ _seconds: ms / 1000, _nanoseconds: 0 })).toBe(ms)
  })

  it("rechaza lo demás, también un serverTimestamp sin resolver (null)", () => {
    for (const malo of ["2026-11-09", null, undefined, 1.5, Number.NaN, {}, { seconds: "1", nanoseconds: 0 }, new Date("nada")]) {
      expect(TimestampSchema.safeParse(malo).success).toBe(false)
      expect(timestampToMillis(malo)).toBeNull()
    }
  })
})

describe("teléfonos", () => {
  it("normaliza un móvil español escrito de muchas formas", () => {
    for (const raw of [
      "612345678",
      "612 34 56 78",
      "612-345-678",
      "(612) 345 678",
      "+34 612 345 678",
      "+34-612-345-678",
      "0034 612 345 678",
      "34612345678",
      "  612.34.56.78 ",
    ]) {
      expect(normalizePhone(raw)).toBe("+34612345678")
    }
  })

  it("es idempotente", () => {
    expect(normalizePhone(normalizePhone("612345678"))).toBe("+34612345678")
    expect(normalizePhone("+447700900123")).toBe("+447700900123")
  })

  it("acepta números de otros países con + o 00", () => {
    expect(normalizePhone("+44 7700 900123")).toBe("+447700900123")
    expect(normalizePhone("0033 6 12 34 56 78")).toBe("+33612345678")
  })

  it("usa el prefijo por defecto y quita el 0 nacional (salvo en Italia)", () => {
    expect(normalizePhone("07700 900123", "44")).toBe("+447700900123")
    expect(normalizePhone("06 1234 5678", "39")).toBe("+390612345678")
  })

  it("explica por qué no vale", () => {
    expect(() => normalizePhone("")).toThrow(InvalidPhoneError)
    expect(() => normalizePhone("")).toThrow("Escribe un teléfono.")
    expect(() => normalizePhone("612 34 56")).toThrow(/9 cifras/)
    expect(() => normalizePhone("512345678")).toThrow(/9 cifras/)
    expect(() => normalizePhone("612abc678")).toThrow(/solo puede llevar cifras/)
    expect(() => normalizePhone("+34 61234567")).toThrow(/9 cifras después del \+34/)
    expect(() => normalizePhone("+1234")).toThrow(/no parece completo/)
    expect(() => normalizePhone("+1234567890123456")).toThrow(/no parece completo/)
    expect(() => normalizePhone("612345678", "abc")).toThrow(/Prefijo de país/)
    expect(tryNormalizePhone("hola")).toBeNull()
  })

  it("el esquema de entrada normaliza o da el mensaje", () => {
    expect(PhoneInputSchema.parse("612 345 678")).toBe("+34612345678")
    const r = PhoneInputSchema.safeParse("123")
    expect(r.success).toBe(false)
    expect(r.error?.issues[0]?.message).toMatch(/9 cifras/)
  })
})

describe("SHA-256", () => {
  // Vectores de FIPS 180-4 / NIST.
  it("da los resultados oficiales", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    )
    expect(
      sha256Hex("abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu"),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1")
    expect(sha256Hex("a".repeat(1_000_000))).toBe("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0")
  })

  it("cifra en UTF-8 como Node", () => {
    // echo -n "Ñu 🍷" | sha256sum
    expect(toArray(utf8Bytes("Ñu 🍷"))).toEqual([0xc3, 0x91, 0x75, 0x20, 0xf0, 0x9f, 0x8d, 0xb7])
    expect(sha256Hex("Ñu 🍷")).toBe("6c4e24e2d4759d15dc3fb5dd705f784a2fee66556bcf9ad70207765cb6dd12a4")
  })

  it("los bordes de bloque (55, 56 y 64 bytes) no fallan", () => {
    // Valores calculados con sha256sum.
    expect(sha256Hex("a".repeat(55))).toBe("9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318")
    expect(sha256Hex("a".repeat(56))).toBe("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a")
    expect(sha256Hex("a".repeat(64))).toBe("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb")
  })
})

function toArray(b: Uint8Array): number[] {
  return [...b]
}

describe("id de cliente", () => {
  it("es estable, de 20 caracteres hexadecimales y distinto por restaurante", () => {
    const a = customerIdFor("demo-lumbre", "+34612345678")
    expect(a).toMatch(/^[0-9a-f]{20}$/)
    expect(customerIdFor("demo-lumbre", "+34612345678")).toBe(a)
    expect(a).toBe(sha256Hex("demo-lumbre:+34612345678").slice(0, 20))
    // Mismo valor que createHash("sha256") de Node: el id sale igual en el navegador y en las funciones.
    expect(a).toBe("5dc0d486be0b352aad68")
    expect(customerIdFor("otro", "+34612345678")).not.toBe(a)
    expect(customerIdFor("demo-lumbre", "+34612345679")).not.toBe(a)
  })

  it("exige el teléfono ya normalizado", () => {
    expect(() => customerIdFor("demo-lumbre", "612345678")).toThrow(/E\.164/)
    expect(() => customerIdFor("", "+34612345678")).toThrow()
    expect(customerIdFor("demo-lumbre", normalizePhone("612 34 56 78"))).toBe(customerIdFor("demo-lumbre", "+34612345678"))
  })
})

describe("referencia de reserva", () => {
  it("no lleva caracteres confusos", () => {
    expect(REFERENCE_ALPHABET).toHaveLength(31)
    for (const c of "01OIL") expect(REFERENCE_ALPHABET).not.toContain(c)
  })

  it("es determinista a partir de los bytes", () => {
    expect(reservationReference(bytes(0, 1, 2, 3, 4, 5))).toBe("234567")
    expect(reservationReference(bytes(30, 31, 61, 62, 247, 8))).toBe("Z2Z2ZA")
  })

  it("salta los bytes que sesgarían el reparto", () => {
    // 248…255 se descartan.
    expect(reservationReference(bytes(248, 255, 0, 1, 2, 3, 4, 5))).toBe("234567")
    expect(() => reservationReference(bytes(250, 251, 0, 1, 2, 3, 4))).toThrow(/Faltan bytes/)
  })

  it("con bytes repartidos salen todos los caracteres por igual", () => {
    const todos = Uint8Array.from({ length: 248 * 6 }, (_, i) => i % 248)
    const cuenta = new Map<string, number>()
    for (let i = 0; i < todos.length; i += 6) {
      for (const c of reservationReference(todos.subarray(i, i + 6))) cuenta.set(c, (cuenta.get(c) ?? 0) + 1)
    }
    expect(new Set(cuenta.values())).toEqual(new Set([48]))
  })

  it("se normaliza lo que escribe una persona", () => {
    expect(normalizeReference(" k7m-2qx ")).toBe("K7M2QX")
    expect(ReservationReferenceInputSchema.parse("k7m 2qx")).toBe("K7M2QX")
    expect(ReservationReferenceInputSchema.safeParse("K7M2Q0").success).toBe(false)
    expect(ReservationReferenceInputSchema.safeParse("K7M2Q").success).toBe(false)
  })
})

describe("token de enlace", () => {
  it("es base64url sin relleno", () => {
    expect(linkToken(new Uint8Array(32))).toBe("A".repeat(43))
    expect(linkToken(Uint8Array.from({ length: 16 }, () => 255))).toBe(`${"_".repeat(21)}w`)
    // Mismo resultado que Buffer.from([...]).toString("base64url").
    expect(linkToken(Uint8Array.from([0xfb, 0xff, 0xbf, ...new Array(13).fill(0)]))).toBe("-_-_AAAAAAAAAAAAAAAAAA")
  })

  it("pide al menos 16 bytes", () => {
    expect(() => linkToken(new Uint8Array(15))).toThrow()
  })
})
