import { readFileSync, realpathSync } from 'node:fs'
import { isIP } from 'node:net'

function hexadecimalKey(file:string|undefined,label:string):Buffer|undefined {
  if(!file)return undefined
  const value=readFileSync(file,'utf8').trim()
  if(!/^[a-f0-9]{64}$/.test(value))throw new Error(`La clave de ${label} debe ser hexadecimal de 32 bytes.`)
  return Buffer.from(value,'hex')
}

/** Único sitio donde el compose de ensayo monta el secreto de la identidad; las pruebas inyectan otro. */
export const REHEARSAL_SECRET_PATH = '/run/secrets/rehearsal_identity_secret'
export function configuration(env: NodeJS.ProcessEnv = process.env, options: { rehearsalSecretPath?: string } = {}) {
  const projectId = env.FIREBASE_PROJECT_ID ?? ''
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId) || projectId.startsWith('demo-')) throw new Error('Falta el proyecto Firebase Auth real.')
  if (env.FIREBASE_AUTH_EMULATOR_HOST || env.FIRESTORE_EMULATOR_HOST || env.FUNCTIONS_EMULATOR || env.FIREBASE_STORAGE_EMULATOR_HOST)
    throw new Error('Este proceso no admite emuladores. Las pruebas inyectan un verificador aislado.')
  // Vía solo de ensayo: identidad de pruebas con clave local. Whitelist estricta de NODE_ENV: ni producción ni sin definir.
  const rehearsalUrl=env.REHEARSAL_IDENTITY_URL?.trim()||undefined
  let rehearsal:{url:string;secret:string}|undefined
  if(rehearsalUrl||env.REHEARSAL_IDENTITY_SECRET_FILE) {
    if(env.NODE_ENV!=='rehearsal')throw new Error('REHEARSAL_IDENTITY_* solo se admite con NODE_ENV=rehearsal: la imagen de producción rechaza la identidad de ensayo.')
    if(!rehearsalUrl||!env.REHEARSAL_IDENTITY_SECRET_FILE)throw new Error('La identidad de ensayo necesita REHEARSAL_IDENTITY_URL y REHEARSAL_IDENTITY_SECRET_FILE.')
    if(env.IDENTITY_ADMIN_CREDENTIAL_FILE)throw new Error('No se mezclan la identidad de ensayo y las credenciales de administración de Auth.')
    if(!projectId.endsWith('-ensayo')||projectId==='llenamos-logiqd')
      throw new Error('En modo ensayo FIREBASE_PROJECT_ID debe ser un identificador de ensayo (terminado en -ensayo), nunca el proyecto de producción.')
    try {
      const u=new URL(rehearsalUrl)
      if(u.protocol!=='http:'||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw new Error()
      const isInternal=u.hostname==='identity'&&(u.port==='9102'||!u.port)
      const isLoopback=(u.hostname==='127.0.0.1'||u.hostname==='localhost')&&Boolean(u.port)
      if(!isInternal&&!isLoopback)throw new Error()
    } catch {
      throw new Error('REHEARSAL_IDENTITY_URL solo admite el servicio interno (http://identity:9102) o loopback de pruebas.')
    }
    // Igualdad exacta tras resolver enlaces simbólicos: un symlink hacia otro secreto o un nombre «parecido» no vale.
    let secretPath:string, allowedPath:string
    try { secretPath=realpathSync(env.REHEARSAL_IDENTITY_SECRET_FILE); allowedPath=realpathSync(options.rehearsalSecretPath??REHEARSAL_SECRET_PATH) }
    catch { throw new Error('REHEARSAL_IDENTITY_SECRET_FILE debe ser el secreto exclusivo de identidad de ensayo y existir.') }
    if(secretPath!==allowedPath)throw new Error('REHEARSAL_IDENTITY_SECRET_FILE debe ser exactamente el secreto exclusivo de identidad de ensayo.')
    const secret=readFileSync(secretPath,'utf8').trim()
    if(!/^[a-f0-9]{48}$/.test(secret))throw new Error('El secreto de la identidad de ensayo debe ser hexadecimal de 24 bytes.')
    rehearsal={url:rehearsalUrl,secret}
  } else if(env.NODE_ENV==='rehearsal') {
    // El worker decide «ensayo» solo por NODE_ENV: la API no puede arrancar como producción con ese valor.
    throw new Error('NODE_ENV=rehearsal exige REHEARSAL_IDENTITY_URL y REHEARSAL_IDENTITY_SECRET_FILE.')
  } else if(projectId.endsWith('-ensayo')) {
    throw new Error('FIREBASE_PROJECT_ID de ensayo no admitido fuera del modo rehearsal.')
  }
  const databaseUrl = env.DATABASE_URL_FILE ? readFileSync(env.DATABASE_URL_FILE, 'utf8').trim() : ''
  if (!databaseUrl || !/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('Falta DATABASE_URL_FILE con la conexión del rol de ejecución.')
  try {
    const parsed=new URL(databaseUrl)
    if (!parsed.hostname || !parsed.username || !parsed.pathname || parsed.hash) throw new Error()
  } catch { throw new Error('La conexión de PostgreSQL no es válida; no se mostrará su contenido.') }
  const port = Number(env.PORT ?? 3100)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT no es válido.')
  const trustedIpHeader=env.TRUSTED_IP_HEADER?.trim().toLowerCase()||undefined
  const trustedProxies=(env.TRUSTED_PROXY_ADDRESSES??'').split(',').map(v=>v.trim()).filter(Boolean)
  // Sin esto todos los visitantes parecerían una sola IP (la del gateway) y los límites de abuso serían globales.
  if((env.NODE_ENV==='production'||rehearsal)&&(!trustedIpHeader||!/^[a-z0-9-]+$/.test(trustedIpHeader)||!trustedProxies.length||trustedProxies.some(v=>!isIP(v))))
    throw new Error('Falta TRUSTED_IP_HEADER y TRUSTED_PROXY_ADDRESSES (IP fija del gateway) para identificar a cada visitante.')
  const identityCredentialFile=env.IDENTITY_ADMIN_CREDENTIAL_FILE||undefined
  const invitationKey=hexadecimalKey(env.PLATFORM_INVITATION_KEY_FILE,'invitaciones')
  const integrationKey=hexadecimalKey(env.PLATFORM_INTEGRATION_KEY_FILE,'integraciones')
  let mail:{origin:string;apiKey:string;from:string}|undefined
  if(env.PLATFORM_EMAIL_ENABLED==='1') {
    if(!identityCredentialFile||!invitationKey||!env.PUBLIC_APP_URL||!env.EMAIL_FROM||!env.RESEND_API_KEY_FILE)throw new Error('Falta configuración explícita del correo de invitaciones.')
    const apiKey=readFileSync(env.RESEND_API_KEY_FILE,'utf8').trim()
    if(!apiKey)throw new Error('Falta la clave del correo de invitaciones.')
    mail={origin:env.PUBLIC_APP_URL,apiKey,from:env.EMAIL_FROM}
  }
  const webhookDatabaseUrl=env.WEBHOOK_DATABASE_URL_FILE?readFileSync(env.WEBHOOK_DATABASE_URL_FILE,'utf8').trim():undefined
  if(webhookDatabaseUrl&&!/^postgres(?:ql)?:\/\//.test(webhookDatabaseUrl))throw new Error('WEBHOOK_DATABASE_URL_FILE no contiene una conexión válida.')
  const filesRoot=env.FILES_ROOT||undefined
  if(filesRoot&&!filesRoot.startsWith('/'))throw new Error('FILES_ROOT debe ser una ruta absoluta del volumen privado.')
  return { projectId, databaseUrl,filesRoot,webhookDatabaseUrl, port, host: env.HOST ?? '0.0.0.0',identityCredentialFile,invitationKey,integrationKey,mail,rehearsal }
}
