/**
 * Archivos privados del VPS (sustituye a `lib/firebase/storage.ts`). Subida y descarga autorizadas con la
 * sesión del usuario: el token va solo en la cabecera, nunca en la URL. Los bytes viven en un volumen del
 * servidor fuera de la raíz pública y se sirven con `nosniff` y sin caché compartida.
 */
import { ApiCallError, type ApiErrorCode } from "./transport"

export const FILE_PURPOSES = {
  /** Foto de un plato de la carta; se puede enseñar al cliente final por enlace estable. */
  carta_foto: { types: ["image/jpeg", "image/png", "image/webp"], maxBytes: 5 * 1024 * 1024 },
  documento: { types: ["application/pdf", "image/jpeg", "image/png"], maxBytes: 8 * 1024 * 1024 },
} as const
export type FilePurpose = keyof typeof FILE_PURPOSES
export interface StoredFile { id: string; contentType: string; sizeBytes: number; sha256: string }

interface FileOptions { fetcher?: typeof fetch; getToken?: () => Promise<string>; signal?: AbortSignal }
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const RID = /^[A-Za-z0-9_-]{1,128}$/

export function validateFile(purpose: FilePurpose, file: Pick<File, "type" | "size">): void {
  const rule = FILE_PURPOSES[purpose]
  if (!(rule.types as readonly string[]).includes(file.type)) throw new ApiCallError("invalid-argument", purpose === "carta_foto" ? "Usa una foto JPG, PNG o WebP." : "Tipo de archivo no admitido.")
  if (file.size <= 0) throw new ApiCallError("invalid-argument", "El archivo está vacío.")
  if (file.size > rule.maxBytes) throw new ApiCallError("invalid-argument", `El archivo puede ocupar hasta ${Math.floor(rule.maxBytes / 1024 / 1024)} MiB.`)
}

async function authorization(options: FileOptions): Promise<string> {
  try {
    const token = await (options.getToken ?? (async () => (await import("@/lib/firebase/auth-client")).identityToken()))()
    if (!token || /[\r\n]/.test(token)) throw new Error()
    return `Bearer ${token}`
  } catch { throw new ApiCallError("unauthenticated", "Tu sesión ha caducado. Vuelve a entrar.") }
}
const CODES: Record<number, ApiErrorCode> = { 400: "invalid-argument", 401: "unauthenticated", 403: "permission-denied", 404: "not-found", 412: "failed-precondition", 413: "resource-exhausted", 415: "invalid-argument" }
async function failure(response: Response): Promise<ApiCallError> {
  const body = await response.json().catch(() => null) as { error?: { message?: unknown; requestId?: unknown } } | null
  const message = typeof body?.error?.message === "string" ? body.error.message : "No se ha podido completar la operación con el archivo."
  const requestId = typeof body?.error?.requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(body.error.requestId) ? body.error.requestId : undefined
  return new ApiCallError(CODES[response.status] ?? (response.status >= 500 ? "unavailable" : "unknown"), message, requestId)
}
async function send(path: string, init: RequestInit, options: FileOptions): Promise<Response> {
  const headers = { ...(init.headers as Record<string, string> | undefined), Authorization: await authorization(options) }
  let response: Response
  try { response = await (options.fetcher ?? fetch)(path, { ...init, headers, signal: options.signal, credentials: "omit", cache: "no-store", redirect: "error" }) }
  catch (error) { if (options.signal?.aborted) throw error; throw new ApiCallError("network", "No hay conexión con el servidor.") }
  if (!response.ok) throw await failure(response)
  return response
}
function base(restaurantId: string): string {
  if (!RID.test(restaurantId)) throw new ApiCallError("invalid-argument", "Restaurante no válido.")
  return `/api/v1/restaurants/${restaurantId}/files`
}

export async function uploadFile(restaurantId: string, purpose: FilePurpose, file: File, options: FileOptions = {}): Promise<StoredFile> {
  validateFile(purpose, file)
  const query = new URLSearchParams({ purpose, name: file.name.slice(0, 120) })
  const response = await send(`${base(restaurantId)}?${query}`, { method: "PUT", headers: { "Content-Type": file.type }, body: file }, options)
  const body = await response.json().catch(() => null) as { result?: StoredFile } | null
  if (!body?.result || !ID.test(body.result.id)) throw new ApiCallError("internal", "La respuesta del servidor no es válida.")
  return body.result
}

/** Descarga con sesión; devuelve los bytes para mostrarlos con `URL.createObjectURL`, sin URL permanente. */
export async function downloadFile(restaurantId: string, fileId: string, options: FileOptions = {}): Promise<Blob> {
  if (!ID.test(fileId)) throw new ApiCallError("invalid-argument", "Archivo no válido.")
  return (await send(`${base(restaurantId)}/${fileId}`, { method: "GET" }, options)).blob()
}

export async function deleteFile(restaurantId: string, fileId: string, options: FileOptions = {}): Promise<void> {
  if (!ID.test(fileId)) throw new ApiCallError("invalid-argument", "Archivo no válido.")
  await send(`${base(restaurantId)}/${fileId}`, { method: "DELETE" }, options)
}

/** Enlace estable para fotos públicas de la carta (el cliente final no tiene sesión). */
export function publicFilePath(restaurantId: string, fileId: string): string {
  if (!RID.test(restaurantId) || !ID.test(fileId)) throw new ApiCallError("invalid-argument", "Archivo no válido.")
  return `/api/v1/public/files/${restaurantId}/${fileId}`
}
