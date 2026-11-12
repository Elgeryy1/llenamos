import { Pool, type PoolClient } from 'pg'
import { assertCurrentIdentity, type IdentityToken } from './auth.js'
import { ApiError } from './errors.js'

export interface PoolTimeouts {
  /** Una transacción abierta sin actividad frena el horizonte de los eventos en vivo de todos. */
  idleInTransactionMs?: number
  /** PostgreSQL 17+: tope absoluto de una transacción (la API solo hace transacciones cortas). */
  transactionMs?: number
  /** Conexiones máximas del pool. Con PostgreSQL a 30 conexiones: API 12, receptor de webhooks 3, worker 5. */
  max?: number
}
export function createPool(connectionString: string, nameOrTimeouts: string | (PoolTimeouts & { applicationName?: string }) = {}) {
  const timeouts = typeof nameOrTimeouts === 'string' ? { applicationName: nameOrTimeouts } : nameOrTimeouts
  const idle = timeouts.idleInTransactionMs ?? 30_000, absolute = timeouts.transactionMs ?? 60_000
  const pool = new Pool({ connectionString, max: timeouts.max ?? 10, connectionTimeoutMillis: 5000, idleTimeoutMillis: 30_000,
    statement_timeout: 10_000, idle_in_transaction_session_timeout: idle, options: `-c transaction_timeout=${absolute}`, application_name: timeouts.applicationName ?? 'llenamos-api' })
  // Un corte del servidor (tiempo de transacción, reinicio) con el cliente prestado no puede tumbar el proceso:
  // la consulta en curso falla, el cliente se descarta y la siguiente petición abre otro.
  pool.on('connect', client => { client.on('error', () => undefined) })
  pool.on('error', () => undefined)
  return pool
}
export async function checkRuntimeRole(pool: Pool) {
  const { rows } = await pool.query<{ privileged: boolean; owns_tables: boolean; runtime: boolean; migrator: boolean }>(`
    SELECT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb) AS privileged,
      pg_has_role(current_user, 'llenamos_app', 'member') AS runtime,
      (pg_has_role(current_user, 'llenamos_migrator', 'member') OR EXISTS(SELECT FROM pg_roles w WHERE w.rolname='llenamos_platform_writer' AND pg_has_role(current_user,w.oid,'member'))) AS migrator,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='llenamos' AND c.relowner=r.oid) AS owns_tables
    FROM pg_roles r WHERE rolname=current_user`)
  if (!rows[0] || rows[0].privileged || rows[0].owns_tables || rows[0].migrator || !rows[0].runtime)
    throw new Error('La API exige un rol de ejecución sin privilegios, propietario ni BYPASSRLS.')
  const separate = await pool.query<{ worker: boolean }>("SELECT EXISTS(SELECT FROM pg_roles WHERE rolname='llenamos_worker' AND pg_has_role(current_user,oid,'member')) AS worker")
  if (separate.rows[0]?.worker) throw new Error('La API no puede pertenecer al rol del worker.')
}
/** El worker es otro proceso: su login es `llenamos_worker` + `llenamos_app` y tampoco puede ser privilegiado. */
export async function checkWorkerRole(pool: Pool) {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
      AND pg_has_role(current_user,'llenamos_worker','member') AND pg_has_role(current_user,'llenamos_app','member')
      AND NOT pg_has_role(current_user,'llenamos_migrator','member')
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='llenamos' AND c.relowner=r.oid) AS ok
    FROM pg_roles r WHERE rolname=current_user`)
  if (!rows[0]?.ok) throw new Error('El worker exige un rol sin privilegios, miembro de llenamos_worker y llenamos_app.')
}
/** Receptor de webhooks: login propio, NO miembro de `llenamos_app` ni del worker; solo ejecuta sus dos funciones. */
export async function checkWebhookRole(pool: Pool) {
  const { rows } = await pool.query<{ ok: boolean }>(`SELECT NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb)
      AND pg_has_role(current_user,'llenamos_webhook','member')
      AND NOT pg_has_role(current_user,'llenamos_app','member') AND NOT pg_has_role(current_user,'llenamos_worker','member')
      AND NOT pg_has_role(current_user,'llenamos_migrator','member')
      AND NOT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='llenamos' AND c.relowner=r.oid) AS ok
    FROM pg_roles r WHERE rolname=current_user`)
  if (!rows[0]?.ok) throw new Error('El receptor de webhooks exige su propio rol llenamos_webhook, sin privilegios ni pertenencia a llenamos_app.')
}
/**
 * La marca `platform_flags.rehearsal` de la base debe coincidir con el modo del proceso, en los dos sentidos.
 * Sin catch: si la consulta falla (tabla ausente, sin privilegio) el proceso no arranca; jamás se asume «producción».
 */
export async function checkRehearsalMark(pool: Pool, isRehearsal: boolean) {
  const { rows } = await pool.query<{ enabled: boolean }>("SELECT enabled FROM llenamos.platform_flags WHERE name='rehearsal'")
  // 015_rehearsal_flag siembra la fila apagada: que no se vea (permiso, política) es un fallo, no «producción».
  if (rows.length !== 1) throw new Error('No se puede leer la marca platform_flags.rehearsal de la base; el proceso se niega a arrancar.')
  const marked = rows[0]!.enabled === true
  if (isRehearsal && !marked) throw new Error('La base de datos conectada no está marcada para ensayo (platform_flags.rehearsal=true); el proceso en modo rehearsal se niega a arrancar.')
  if (!isRehearsal && marked) throw new Error('La base de datos conectada está marcada para ensayo; el proceso en producción se niega a arrancar.')
}
export async function checkReadiness(pool:Pool,invitations=false,isRehearsal=false) {
  await checkRuntimeRole(pool)
  const tables=['identities','restaurants','memberships','locations','platform_restaurants','platform_plans','platform_subscriptions','platform_usage','platform_requests','integration_secrets','platform_audit','message_deliveries','files','webhook_events','privacy_requests','integration_webhook_secrets','message_optouts','events','sync_devices','sync_streams','sync_receipts','sync_resolutions','sync_activity']
  if(invitations)tables.push('account_invitations')
  tables.push('reservations','reservation_settings','dining_tables','customers','waitlist','abuse_counters') // 007_reservas
  const functions=['platform_create','platform_configure','platform_configuration','platform_request','platform_integrations','webhook_signing_secret','webhook_accept','file_public_lookup','platform_webhook_secrets','notify_event','restaurant_settings_save']
  if(invitations)functions.push('invitation_prepare','invitation_begin','invitation_finish','invitation_owner_pending')
  tables.push('platform_onboardings','api_keys','webhook_endpoints','webhook_deliveries','billing_events','platform_flags') // 012_billing_api
  functions.push('billing_view','billing_event_commit','billing_expire_due','api_key_authenticate','platform_emit_event')
  functions.push('reservas_public_resolve','reservas_link_lookup','abuse_hit') // 007_reservas
  const {rows}=await pool.query<{ready:boolean}>(`SELECT bool_and(to_regclass('llenamos.'||name) IS NOT NULL) AS ready FROM unnest($1::text[]) AS name`,[tables])
  const result=await pool.query<{ready:boolean}>(`SELECT (SELECT count(DISTINCT p.proname) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='llenamos' AND p.proname=ANY($1::text[]))=cardinality($1::text[])
    AND EXISTS(SELECT FROM pg_attribute WHERE attrelid='llenamos.restaurants'::regclass AND attname='entitlement_version' AND NOT attisdropped)
    AND EXISTS(SELECT FROM pg_attribute WHERE attrelid='llenamos.platform_restaurants'::regclass AND attname='integration_status' AND NOT attisdropped)
    AND has_table_privilege(current_user,'llenamos.platform_flags','SELECT') AS ready`,[functions]) // marca de ensayo (015_rehearsal_flag)
  if(!rows[0]?.ready||!result.rows[0]?.ready)throw new Error('El esquema de la API no está migrado.')
  await checkRehearsalMark(pool,isRehearsal)
}
export async function withIdentity<T>(pool: Pool, token: IdentityToken, restaurantId: string | null,
  operation: (client: PoolClient, platform: boolean) => Promise<T>): Promise<T> {
  if (restaurantId && !/^[A-Za-z0-9_-]{1,128}$/.test(restaurantId)) throw new ApiError(400, 'invalid-argument', 'Restaurante no válido.')
  const client = await pool.connect()
  let broken = false
  try {
    await client.query('BEGIN')
    // true limita cada contexto a esta transacción; COMMIT/ROLLBACK lo restaura en el pool.
    await client.query("SELECT set_config('app.actor_uid',$1,true),set_config('app.platform','false',true),set_config('app.restaurant_id',$2,true)", [token.uid, restaurantId ?? ''])
    const { rows } = await client.query<{ session_version: string; tokens_valid_after: Date; locked: boolean; disabled: boolean; platform_operator: boolean }>(
      'SELECT session_version,tokens_valid_after,locked,disabled,platform_operator FROM llenamos.identities WHERE uid=$1', [token.uid])
    const row = rows[0]
    assertCurrentIdentity(token, row ? { sessionVersion: row.session_version, tokensValidAfter: row.tokens_valid_after.getTime(), locked: row.locked, disabled: row.disabled } : null)
    // Un claim firmado de plataforma no reemplaza el alta/autorización operativa en SQL.
    if (token.platformClaim && !row!.platform_operator) throw new ApiError(403,'permission-denied','El acceso de plataforma no está habilitado.')
    const platform = row!.platform_operator
    await client.query("SELECT set_config('app.platform',$1,true)", [String(platform)])
    const result = await operation(client, platform)
    await client.query('COMMIT')
    return result
  } catch (error) {
    try { await client.query('ROLLBACK') } catch { broken = true }
    throw error
  } finally { client.release(broken) }
}
