"use client"

import { LinkTokenSchema } from "@llenamos/core"
import { EnvelopeSimpleIcon, CheckCircleIcon } from "@phosphor-icons/react"
import { useRef, useState } from "react"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { llamarMarketing } from "@/lib/campanas/api"

export const RESPUESTA_BAJA =
  "Si el enlace corresponde a un permiso de marketing, la baja queda registrada. Los avisos necesarios sobre tus reservas seguirán llegando."

export function BajaView({ slug, token }: { slug: string; token: string }) {
  const [estado, setEstado] = useState<"initial" | "busy" | "done" | "error">("initial")
  const [website, setWebsite] = useState("")
  const ocupado = useRef(false)
  async function baja() {
    if (ocupado.current) return
    ocupado.current = true
    setEstado("busy")
    // Un enlace mal formado sigue el mismo camino y recibe la misma respuesta, sin revelar contactos.
    const parsed = LinkTokenSchema.safeParse(token)
    try {
      await llamarMarketing("darseDeBaja", { slug, token: parsed.success ? parsed.data : "enlace_sin_token_valido_de_baja", website })
      setEstado("done")
    } catch {
      setEstado("error")
    } finally {
      ocupado.current = false
    }
  }
  return (
    <main className="mx-auto flex min-h-svh max-w-lg items-center px-4 py-8">
      <section className="superficie w-full space-y-5 p-6 sm:p-8">
        <div className="flex size-12 items-center justify-center rounded-full bg-surface-raised text-primary">
          {estado === "done" ? <CheckCircleIcon aria-hidden size={26} /> : <EnvelopeSimpleIcon aria-hidden size={26} />}
        </div>
        <p className="text-sm text-muted-foreground">Preferencias de mensajes · Llenamos</p>
        <h1 className="text-2xl font-semibold tracking-tight">{estado === "done" ? "Solicitud atendida" : "Dejar de recibir novedades"}</h1>
        {estado === "done" ? (
          <p role="status" className="text-sm leading-relaxed text-soft-foreground">
            {RESPUESTA_BAJA}
          </p>
        ) : (
          <>
            <p className="text-sm leading-relaxed text-soft-foreground">
              Pide la baja de las novedades y ofertas del canal de este enlace. No necesitas iniciar sesión. Los avisos sobre tus reservas
              son independientes.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void baja()
              }}
              className="space-y-4"
            >
              <div className="hidden" aria-hidden>
                <label htmlFor="website">Página web</label>
                <input
                  id="website"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                />
              </div>
              <Button className="h-12 w-full text-base" disabled={estado === "busy"} type="submit">
                {estado === "busy" ? "Atendiendo solicitud…" : "Dar de baja este canal"}
              </Button>
            </form>
            {estado === "error" ? (
              <Notice tone="error" title="No hemos podido confirmar la baja">
                El servicio de baja no está disponible en este momento. Vuelve a intentarlo. No se ha confirmado ningún cambio.
              </Notice>
            ) : null}
          </>
        )}
        <p className="border-t pt-4 text-xs leading-relaxed text-muted-foreground">
          No mostramos datos de contacto ni el estado de un enlace por privacidad.
        </p>
      </section>
    </main>
  )
}
