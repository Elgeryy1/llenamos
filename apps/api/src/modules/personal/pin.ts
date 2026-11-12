/**
 * PIN del puesto de fichaje en el servidor: scrypt con sal propia (la huella de una sola pasada de core se rompe por
 * fuerza bruta: solo hay 10⁶ PIN posibles) y un bloqueo que crece con cada tanda de fallos (5 min, 10, 20… hasta 24 h).
 * El registro conserva la forma de `PinRecordSchema` más `lockRounds`; la huella son 32 bytes (64 hex).
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import * as core from '@llenamos/core'

export const PinDocSchema = core.PinRecordSchema.extend({ lockRounds: z.number().int().min(0).max(20).default(0) })
export type PinDoc = z.infer<typeof PinDocSchema>
const MAX_LOCK_MS = 24 * 60 * 60_000

const derive = (pin: string, uid: string, salt: string) => new Promise<Buffer>((resolve, reject) =>
  scrypt(pin, `llenamos-pin:${uid}:${salt}`, 32, { N: 16384, r: 8, p: 1 }, (error, key) => (error ? reject(error) : resolve(key))))

export async function newPinDoc(pin: string, uid: string): Promise<PinDoc> {
  const salt = randomBytes(16).toString('hex')
  return { pinHash: (await derive(pin, uid, salt)).toString('hex'), salt, failedAttempts: 0, lockedUntil: null, lockRounds: 0 }
}

export type PinResult =
  | { ok: true; record: PinDoc }
  | { ok: false; reason: 'locked' | 'wrong'; record: PinDoc; lockedUntil: number | null; attemptsLeft: number }

export async function checkPinDoc(record: PinDoc, pin: string, uid: string, now: number): Promise<PinResult> {
  if (record.lockedUntil !== null && now < record.lockedUntil) return { ok: false, reason: 'locked', record, lockedUntil: record.lockedUntil, attemptsLeft: 0 }
  const base: PinDoc = { ...record, lockedUntil: null }
  const good = timingSafeEqual(await derive(pin, uid, record.salt), Buffer.from(record.pinHash, 'hex'))
  if (good) return { ok: true, record: { ...base, failedAttempts: 0, lockRounds: 0 } }
  const failed = base.failedAttempts + 1
  if (failed >= core.PIN_MAX_ATTEMPTS) {
    const lockedUntil = now + Math.min(core.PIN_LOCK_MS * 2 ** base.lockRounds, MAX_LOCK_MS)
    return { ok: false, reason: 'locked', record: { ...base, failedAttempts: 0, lockRounds: Math.min(base.lockRounds + 1, 20), lockedUntil }, lockedUntil, attemptsLeft: 0 }
  }
  return { ok: false, reason: 'wrong', record: { ...base, failedAttempts: failed }, lockedUntil: null, attemptsLeft: core.PIN_MAX_ATTEMPTS - failed }
}
