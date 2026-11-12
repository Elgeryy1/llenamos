import { createCipheriv, createDecipheriv, createHash, randomBytes, createHmac, timingSafeEqual } from 'node:crypto'
import { getStorage } from 'firebase-admin/storage'
import { Timestamp, type Transaction, type DocumentData, type DocumentReference } from 'firebase-admin/firestore'
import { HttpsError, type CallableRequest } from 'firebase-functions/v2/https'
import * as core from '@llenamos/core'
import { db, membership, uidOf } from '../shared'

export const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
export const rootOf = (rid: string) => db.doc(`restaurants/${core.DocIdSchema.parse(rid)}`)
export function custodyConfiguration() {
  const local = (host: string | undefined) => /^(127\.0\.0\.1|localhost):\d+$/.test(host ?? '')
  const project = process.env.GCLOUD_PROJECT
  if (project === 'demo-llenamos' && local(process.env.FIRESTORE_EMULATOR_HOST) && local(process.env.FIREBASE_STORAGE_EMULATOR_HOST))
    return { local:true, bucketName:'demo-llenamos.appspot.com' }
  const emulator = ['FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST'].some(name => !!process.env[name]) || process.env.FUNCTIONS_EMULATOR === 'true'
  const bucketName = process.env.PLATFORM_DATA_BUCKET ?? ''
  if (!project || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(project) || project.startsWith('demo-') || emulator
    || process.env.PLATFORM_CUSTODY_ENABLED !== '1'
    || ![`${project}.appspot.com`,`${project}.firebasestorage.app`].includes(bucketName))
    throw new HttpsError('failed-precondition', 'Falta configurar y habilitar la custodia de producción del proyecto. No se ha leído ni escrito ningún archivo.')
  key()
  return { local:false, bucketName }
}
/** Valida el destino explícito y la clave antes de cualquier trabajo de continuidad. */
export function assertCustody() { custodyConfiguration() }
/** Compatibilidad de los trabajadores: esta guardia ahora valida también producción. */
export const localOnly = assertCustody
export function assertBackupCaptureAllowed() {
  if (!custodyConfiguration().local) throw new HttpsError('failed-precondition', 'La copia de producción requiere una barrera de mantenimiento que cubra escritores y disparadores. El recorrido local no acredita una captura coherente en línea; usa las copias gestionadas hasta completar esa barrera.')
}
export function key(version = 'v1') {
  if (version !== 'v1') throw new Error('Versión de clave desconocida.')
  const configured = process.env.PLATFORM_DATA_KEY_V1 ?? '', value = Buffer.from(configured, 'base64')
  if (value.length !== 32 || value.toString('base64') !== configured) throw new HttpsError('failed-precondition', 'Falta la clave de custodia del servidor. No se ha creado ningún archivo.')
  return value
}
export function encrypt(bytes: Buffer, scope: string) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(), nonce)
  cipher.setAAD(Buffer.from(scope))
  const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext])
}
export function decrypt(bytes: Buffer, scope: string) {
  const decipher = createDecipheriv('aes-256-gcm', key(), bytes.subarray(0, 12))
  decipher.setAAD(Buffer.from(scope)); decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()])
}
export const bucket = () => getStorage().bucket(custodyConfiguration().bucketName)
export async function savePrivate(path: string, bytes: Buffer) {
  localOnly()
  await bucket().file(path).save(encrypt(bytes, path), { resumable: false, metadata: { contentType: 'application/octet-stream', metadata: { keyVersion: 'v1' } } })
}
export async function readPrivate(path: string) { localOnly(); return decrypt((await bucket().file(path).download())[0], path) }
export async function deletePrivate(path: string) { localOnly(); await bucket().file(path).delete({ ignoreNotFound: true }) }
export async function authorize(tx: Transaction, rid: string, request: CallableRequest<unknown>, internal = false) {
  const uid = uidOf(request)
  const actor = await membership(tx, rid, uid)
  if (request.auth?.token.logiqd === true || (internal && actor.role !== 'owner')) throw new HttpsError('permission-denied', 'Solo el propietario del restaurante puede gestionar sus copias; LogiQD no accede a su contenido.')
  if (!actor.active || !core.can(actor.role, 'privacidad.gestionar') || actor.locationIds.length) throw new HttpsError('permission-denied', 'Necesitas acceso a todo el restaurante para gestionar sus datos personales.')
  return uid
}
export const metadata = (uid: string | null = null) => ({ updatedBy: uid, updatedAt: Timestamp.now() })
export function audit(tx: Transaction, rid: string, id: string, action: string, uid: string | null) {
  tx.set(rootOf(rid).collection('activity').doc(digest(id)), { action, summary: 'Gestión de privacidad o continuidad registrada.', actorUid: uid, actorName: null, entity: { type: 'privacy', id: digest(id).slice(0,20) }, createdAt: Timestamp.now(), ...metadata(uid) })
}
export function signedCursor(scope: string, id: string): string {
  const body = Buffer.from(JSON.stringify({ scope, id })).toString('base64url')
  return `${body}.${createHmac('sha256',key()).update(body).digest('hex')}`
}
export function cursorId(scope: string, cursor: string | null) {
  if (!cursor) return null
  try {
    const [body, mac] = cursor.split('.'), expected = createHmac('sha256',key()).update(body!).digest()
    if (!mac || !timingSafeEqual(Buffer.from(mac,'hex'), expected)) throw new Error()
    const parsed = JSON.parse(Buffer.from(body!,'base64url').toString()) as { scope:string;id:string }
    if (parsed.scope !== scope) throw new Error()
    return core.DocIdSchema.parse(parsed.id)
  } catch { throw new HttpsError('invalid-argument','El cursor no corresponde a esta consulta.') }
}
export type Row = { path: string; data: DocumentData }
export const collectionOf = (row: Row) => row.path.split('/').at(-2)!
export const idOf = (row: Row) => row.path.split('/').at(-1)!
/** Todas las consultas usan la misma transacción y su snapshot, también al descubrir subcolecciones. */
export async function readTree(tx: Transaction, root: DocumentReference, max = 6000): Promise<Row[]> {
  const rows: Row[] = []
  const pending = [{ ref:root,depth:0 }], visited = new Set<string>()
  // Un restaurante con historial tiene miles de hojas. Lecturas acotadas en paralelo mantienen
  // el mismo snapshot transaccional sin esperar una ida y vuelta por cada documento.
  while (pending.length) {
    const batch = pending.splice(0,8).filter(({ref}) => !visited.has(ref.path))
    for (const {ref,depth} of batch) {
      if (depth > 12 || rows.length > max) throw new HttpsError('resource-exhausted', 'El inventario supera el límite local. No se completa parcialmente.')
      visited.add(ref.path)
    }
    const found = await Promise.all(batch.map(async ({ref,depth}) => {
      const snap = await tx.get(ref)
      const children = []
      for (const col of await ref.listCollections()) {
        // listDocuments incluye padres vacíos con subcolecciones.
        const [refs,docs] = await Promise.all([col.listDocuments(),tx.get(col)])
        const all = new Map([...refs,...docs.docs.map(d => d.ref)].map(r => [r.path,r]))
        children.push(...[...all.values()].map(child => ({ref:child,depth:depth+1})))
      }
      return {row:snap.exists ? {path:ref.path,data:snap.data()!} : null,children}
    }))
    for (const item of found) { if (item.row) rows.push(item.row);pending.push(...item.children) }
    if (rows.length > max) throw new HttpsError('resource-exhausted', 'El inventario supera el límite local. No se completa parcialmente.')
  }
  return rows.sort((a,b) => a.path.localeCompare(b.path))
}
export function encode(value: unknown): unknown {
  if (value instanceof Timestamp) return { $timestamp: [value.seconds,value.nanoseconds] }
  if (Buffer.isBuffer(value)) return { $bytes: value.toString('base64') }
  if (Array.isArray(value)) return value.map(encode)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,encode(v)]))
  return value
}
export function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (Array.isArray(v.$timestamp)) return new Timestamp(Number(v.$timestamp[0]),Number(v.$timestamp[1]))
    if (typeof v.$bytes === 'string') return Buffer.from(v.$bytes,'base64')
    return Object.fromEntries(Object.entries(v).map(([k,x]) => [k,decode(x)]))
  }
  return value
}

/** Incluye respuestas globales acotadas al restaurante, nunca las de otro inquilino. */
export async function readPersonalTree(tx: Transaction, rid: string): Promise<Row[]> {
  const rows = await readTree(tx,rootOf(rid))
  const requests = await tx.get(db.collection('platformRequests').where('restaurantId','==',rid))
  return [...rows,...requests.docs.map(d => ({ path:d.ref.path,data:d.data() }))]
}
