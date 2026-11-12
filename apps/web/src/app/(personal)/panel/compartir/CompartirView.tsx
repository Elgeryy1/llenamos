"use client"

import { ArrowSquareOutIcon, CheckIcon, CopyIcon, LinkIcon, GoogleLogoIcon, InstagramLogoIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { useState, useSyncExternalStore } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SettingsSection as Section } from "@/components/common/settings-section"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading as PageHeader } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import * as C from "@/lib/compartir/enlaces"
import { usePublicRestaurant } from "@/lib/config/hooks"

export function CompartirView() {
  return (
    <RequirePermission permission="reservas.configurar" what="el enlace de reservas">
      <RequireModule module="reservations">
        <Compartir />
      </RequireModule>
    </RequirePermission>
  )
}

/** Origen de la web en el navegador (en el servidor, vacío hasta hidratar). */
function useOrigin(): string {
  return useSyncExternalStore(
    () => () => {},
    () => C.siteOrigin(process.env.NEXT_PUBLIC_SITE_URL, window.location.origin),
    () => "",
  )
}

/** Copia sin depender de permisos: área de texto temporal y la orden de copiar del navegador. */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement("textarea")
  area.value = text
  area.setAttribute("readonly", "")
  area.style.position = "fixed"
  area.style.opacity = "0"
  document.body.appendChild(area)
  area.select()
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  area.remove()
  return ok
}

/** El portapapeles moderno, con un límite de espera (algunos navegadores se quedan esperando un permiso). */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    const ok = await Promise.race([
      navigator.clipboard.writeText(text).then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2000)),
    ])
    if (ok) return true
  }
  return copyWithTextarea(text)
}

function CopyButton({ text, label, primary = false }: { text: string; label: string; primary?: boolean }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle")
  return (
    <>
      <Button
        variant={primary ? "default" : "outline"}
        className="shadow-soft"
        size="lg"
        disabled={!text}
        onClick={() => {
          void copyText(text).then((ok) => {
            setState(ok ? "copied" : "failed")
            if (ok) setTimeout(() => setState("idle"), 2500)
          })
        }}
      >
        {state === "copied" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {state === "copied" ? "Copiado" : label}
      </Button>
      <span aria-live="polite" className="sr-only">
        {state === "copied" ? "Copiado al portapapeles" : ""}
      </span>
      {state === "failed" ? (
        <span role="alert" className="text-xs text-destructive">
          No se ha podido copiar: selecciónalo y cópialo a mano.
        </span>
      ) : null}
    </>
  )
}

function Compartir() {
  const { restaurant } = usePanel()
  const origin = useOrigin()
  const pub = usePublicRestaurant(restaurant.slug)
  const [kind, setKind] = useState<"script" | "iframe">("script")

  const url = origin ? C.bookingUrl(origin, restaurant.slug) : ""
  const code = origin
    ? kind === "script"
      ? C.widgetScriptSnippet(origin, restaurant.slug)
      : C.widgetIframeSnippet(origin, restaurant.slug, restaurant.name)
    : ""

  const state = pub.status === "ready" ? C.bookingState(pub.data) : null

  return (
    <>
      <PageHeader
        eyebrow={<><span className="text-soft-foreground">{restaurant.name}</span> · Compartir</>}
        title={state?.kind === "open" ? "Tu página ya acepta reservas" : "Comparte tu página de reservas"}
        description="Un mismo enlace para tu web, la bio de Instagram y el botón «Reservar» de Google Maps."
      />

      {pub.status === "loading" ? (
        <LoadingBlock label="Comprobando la página pública…" className="mb-4">
          <Skeleton className="h-12 w-full rounded-xl" />
        </LoadingBlock>
      ) : pub.status === "error" ? (
        <div className="mb-4">
          <LiveError title="No se ha podido comprobar la página pública" error={pub.error} />
        </div>
      ) : state ? (
        <Notice
          tone={state.kind === "open" ? "success" : "warning"}
          className="mb-6 bg-card shadow-soft"
          title={<span className="flex items-center gap-2"><span aria-hidden className={`size-2 rounded-full ${state.kind === "open" ? "bg-success" : "bg-warning"}`} />{state.kind === "open" ? "Página publicada" : "Reservas no disponibles"}</span>}
          action={
            state.kind === "public_booking_off" || state.kind === "missing" ? (
              <Button variant="outline" size="sm" className="pointer-coarse:min-h-11" asChild>
                <Link href="/panel/horarios">Ir a horarios y reservas</Link>
              </Button>
            ) : undefined
          }
        >
          {C.BOOKING_STATE_TEXT[state.kind]}
        </Notice>
      ) : null}

      <div className="flex flex-col gap-6">
        <Section id="enlace" title="Enlace de reservas" description="Llévalo a cualquier sitio: mensajes, carta, código QR o redes.">
          <div className="flex flex-wrap items-center gap-3">
            <div aria-hidden className="flex size-12 shrink-0 items-center justify-center rounded-xl border bg-surface-raised text-soft-foreground"><LinkIcon size={24} /></div>
            <output aria-label="Enlace de reservas" className="cifra min-w-0 flex-1 basis-52 break-all rounded-lg border bg-surface-sunken px-3 py-3 text-sm text-soft-foreground">
              {url || "…"}
            </output>
            <CopyButton text={url} label="Copiar enlace" primary />
            <Button variant="outline" size="lg" className="shadow-soft pointer-coarse:min-h-11" asChild>
              <a href={url || undefined} target="_blank" rel="noreferrer">
                <ArrowSquareOutIcon aria-hidden />
                Abrir
              </a>
            </Button>
          </div>
        </Section>

        <Section
          id="widget"
          title="Widget para tu web"
          description="Pega este código en tu web, donde quieras que aparezca la reserva. Lo puede hacer quien te lleva la web."
          action={
            <SegmentedControl
              label="Tipo de código"
              value={kind}
              onValueChange={setKind}
              options={[
                { value: "script", label: "Botón" },
                { value: "iframe", label: "Incrustado" },
              ]}
            />
          }
        >
          <p className="text-sm text-muted-foreground">
            {kind === "script"
              ? "Añade un botón «Reservar» que abre la reserva encima de tu web, sin salir de ella."
              : "Pone el formulario de reserva dentro de la página. Sirve en webs que no dejan añadir scripts (Wix, Squarespace o WordPress.com)."}
          </p>
          <pre className="cifra max-w-full overflow-x-auto rounded-lg border bg-surface-sunken p-4 text-xs leading-relaxed whitespace-pre text-soft-foreground">
            <code>{code || "…"}</code>
          </pre>
          <div className="flex flex-wrap items-center gap-2">
            <CopyButton text={code} label="Copiar código" />
          </div>
        </Section>

        <Section id="redes" title="Instagram y Google Maps" description="Así llegan los clientes que te buscan en el móvil.">
          <div className="grid gap-6 md:grid-cols-2 md:gap-10">
            <div className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <InstagramLogoIcon aria-hidden className="size-4" />
                Instagram
              </h3>
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-soft-foreground">
                <li>En tu perfil, pulsa «Editar perfil».</li>
                <li>En «Enlaces», añade un enlace externo y pega el enlace de reservas.</li>
                <li>Ponle de título «Reservar mesa».</li>
                <li>Si tienes cuenta de empresa, añade también el botón de acción «Reservar» con el mismo enlace.</li>
              </ol>
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold">
                <GoogleLogoIcon aria-hidden className="size-4" />
                Google Maps
              </h3>
              <ol className="list-decimal space-y-2 pl-5 text-sm leading-relaxed text-soft-foreground">
                <li>Entra en tu Perfil de Empresa de Google (busca el nombre del restaurante con tu cuenta).</li>
                <li>Pulsa «Editar perfil» y ve a «Reservas».</li>
                <li>Añade un enlace de reservas y pega el enlace de arriba.</li>
                <li>Google puede tardar unos días en enseñar el botón «Reservar».</li>
              </ol>
              <p className="text-xs text-muted-foreground">Reservar con Google como socio oficial no está incluido: necesita una aprobación aparte de Google.</p>
            </div>
          </div>
        </Section>
      </div>
    </>
  )
}
