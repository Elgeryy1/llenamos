"use client"

import { DownloadSimpleIcon } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { modoVps } from "@/lib/fase4/vivo"
import type { Alcance } from "@/lib/personal/api"
import { descargarRegistroJornada, fichajesTexto, TEXTO_RETENCION, TEXTO_RETENCION_ENCARGADO } from "@/lib/personal/exportar"

/**
 * Descarga del registro de jornada. Solo existe en el VPS, que es donde se conserva el registro legal.
 * `uid` null es la copia propia; la de otra persona la pide un encargado a petición del trabajador.
 */
export function ExportarRegistro({ scope, uid, etiqueta = "Descargar mi registro de jornada" }: { scope: Alcance; uid: string | null; etiqueta?: string }) {
  const [ocupado, setOcupado] = useState(false)
  const [aviso, setAviso] = useState<{ tono: "success" | "error"; texto: string } | null>(null)
  const enCurso = useRef(false)
  if (!modoVps()) return null
  async function descargar() {
    if (enCurso.current) return
    enCurso.current = true
    setOcupado(true)
    setAviso(null)
    const r = await descargarRegistroJornada(scope, uid)
    setAviso(r.ok ? { tono: "success", texto: `Archivo ${r.archivo} con ${fichajesTexto(r.fichajes)}.` } : { tono: "error", texto: r.message })
    enCurso.current = false
    setOcupado(false)
  }
  return (
    <section className="superficie space-y-3 p-5" aria-label="Registro de jornada">
      <h2 className="text-base font-semibold">Registro de jornada</h2>
      <p className="text-sm text-muted-foreground">{uid === null ? TEXTO_RETENCION : TEXTO_RETENCION_ENCARGADO}</p>
      <Button variant="outline" disabled={ocupado} onClick={() => void descargar()}>
        <DownloadSimpleIcon aria-hidden className="size-4" /> {ocupado ? "Preparando…" : etiqueta}
      </Button>
      {aviso ? <Notice tone={aviso.tono}>{aviso.texto}</Notice> : null}
    </section>
  )
}
