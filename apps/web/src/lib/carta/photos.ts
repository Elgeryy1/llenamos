import { publicFilePath, uploadFile } from "@/lib/api/files"
import { enVps } from "@/lib/sala/vivo"
import { cargarStorage, cargarStorageDemo } from "@/lib/firebase/cargar-demo"

/**
 * En VPS la foto es un archivo `carta_foto` del servicio de archivos; la ruta guardada en el plato conserva la forma del
 * contrato (`restaurants/{rid}/locations/{lid}/menu/{plato}/{archivo}`) y su último tramo es el ID del archivo.
 */
const RUTA_VPS = /^restaurants\/([^/]+)\/locations\/[^/]+\/menu\/[^/]+\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/
async function storage() {
  const [{ getBlob, ref, uploadBytes }, { getStorageClient }] = await Promise.all([cargarStorage(), cargarStorageDemo()])
  return { getBlob, ref, uploadBytes, client: getStorageClient() }
}
export function validatePhoto(file: Pick<File, "type" | "size">) {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) throw new Error("Usa una foto JPG, PNG o WebP.")
  if (file.size > 5 * 1024 * 1024) throw new Error("La foto puede ocupar hasta 5 MiB.")
}
export async function uploadPhoto(restaurantId: string, locationId: string, itemId: string, file: File) {
  validatePhoto(file)
  if (enVps) {
    const stored = await uploadFile(restaurantId, "carta_foto", file)
    return `restaurants/${restaurantId}/locations/${locationId}/menu/${itemId}/${stored.id}`
  }
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[file.type]
  const path = `restaurants/${restaurantId}/locations/${locationId}/menu/${itemId}/${crypto.randomUUID()}.${extension}`
  const { ref, uploadBytes, client } = await storage()
  await uploadBytes(ref(client, path), file, { contentType: file.type })
  return path
}
/** Demo: descarga autorizada por reglas, sin URL permanente con token. VPS: enlace público estable de la foto. */
export async function photoBlob(path: string) {
  if (enVps) {
    const match = RUTA_VPS.exec(path)
    if (!match) throw new Error("La foto no está disponible.")
    // Las fotos de la carta se enseñan también al cliente final: enlace estable sin sesión ni cookies.
    const response = await fetch(publicFilePath(match[1]!, match[2]!), { credentials: "omit", redirect: "error" })
    if (!response.ok) throw new Error("La foto no está disponible.")
    return response.blob()
  }
  const { getBlob, ref, client } = await storage()
  return getBlob(ref(client, path), 5 * 1024 * 1024)
}
