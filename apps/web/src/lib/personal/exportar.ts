"use client"

import { FICHAJES_RETENCION_ANIOS } from "@llenamos/core"
import { errorPersonal, llamarPersonal, type Alcance } from "./api"

const CONSERVACION = `El registro de jornada se conserva ${FICHAJES_RETENCION_ANIOS} años por obligación legal y no se puede borrar antes. Pasado ese plazo se anonimiza.`
export const TEXTO_RETENCION = `${CONSERVACION} Puedes descargar tu copia cuando quieras.`
export const TEXTO_RETENCION_ENCARGADO = `${CONSERVACION} A petición de la persona, puedes descargar su copia.`

/** Parte del nombre del archivo que distingue a la persona: el uid recortado, nunca el nombre. */
const corto = (uid: string) => uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8)

export const fichajesTexto = (n: number) => `${n} ${n === 1 ? "fichaje" : "fichajes"}`

/** Pide el registro de jornada de una persona (`uid` null es el propio) y lo entrega como archivo JSON. */
export async function descargarRegistroJornada(scope: Alcance, uid: string | null): Promise<{ ok: true; archivo: string; fichajes: number } | { ok: false; message: string }> {
  try {
    const data = await llamarPersonal("exportarMisFichajes", { ...scope, uid })
    const archivo = `registro-de-jornada-${corto(data.uid)}-${new Date(data.generatedAt).toISOString().slice(0, 10)}.json`
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }))
    const enlace = document.createElement("a")
    enlace.href = url
    enlace.download = archivo
    enlace.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
    return { ok: true, archivo, fichajes: data.entries.length }
  } catch (error) {
    return { ok: false, message: errorPersonal(error) }
  }
}
