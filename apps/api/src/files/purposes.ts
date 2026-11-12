import { ROLES, can, type Permission } from '@llenamos/core'

export interface FilePurpose {
  /** Permiso para subir y borrar. Quien no lo tenga no puede escribir. */
  write: Permission
  /** Permiso para descargar con sesión. */
  read: Permission
  types: readonly string[]
  maxBytes: number
  /** Descarga sin sesión por enlace estable (datos que el cliente final ya ve, como las fotos de la carta). */
  publicRead: boolean
  /** Solo lo crea el servidor (exportaciones de privacidad); no se sube por HTTP. */
  internal?: boolean
}

export const FILE_PURPOSES: Readonly<Record<string, FilePurpose>> = {
  carta_foto: { write: 'carta.editar', read: 'carta.agotar', types: ['image/jpeg', 'image/png', 'image/webp'], maxBytes: 5 * 1024 * 1024, publicRead: true },
  documento: { write: 'ajustes.gestionar', read: 'ajustes.gestionar', types: ['application/pdf', 'image/jpeg', 'image/png'], maxBytes: 8 * 1024 * 1024, publicRead: false },
  exportacion_privacidad: { write: 'privacidad.gestionar', read: 'privacidad.gestionar', types: ['application/json'], maxBytes: 50 * 1024 * 1024, publicRead: false, internal: true },
}
/** Tope por restaurante: evita llenar el volumen con subidas legítimas repetidas. */
export const QUOTA = { bytes: 512 * 1024 * 1024, files: 5000 }

export const rolesWith = (permission: Permission) => ROLES.filter(role => can(role, permission))

/** El contenido manda sobre la cabecera del cliente: se comprueban los primeros bytes. */
export function sniff(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  if (head.length >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf'
  return null
}
