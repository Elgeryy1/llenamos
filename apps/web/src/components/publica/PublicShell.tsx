"use client"

import { LANGUAGES, type Language } from "@llenamos/core"
import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/cn"
import { brandStyle, initials } from "@/lib/publica/brand"
import { LANGUAGE_NAMES } from "@/lib/publica/i18n"
import { usePublic } from "./PublicContext"
import styles from "./publica.module.css"

/**
 * Variables de la marca del restaurante. Los Popover y Dialog se pintan fuera del
 * contenedor (en un portal), así que las leen de aquí para llevar el mismo color.
 */
const MarcaContext = createContext<React.CSSProperties | undefined>(undefined)
export function useMarca(): React.CSSProperties | undefined {
  return useContext(MarcaContext)
}

export function SelectorIdioma() {
  const { lang, setLang, t } = usePublic()
  return (
    <ToggleGroup
      type="single"
      size="sm"
      spacing={1}
      aria-label={t("language")}
      className="shrink-0 rounded-2xl border bg-surface-sunken p-1"
      value={lang}
      onValueChange={(next) => {
        if (next) setLang(next as Language)
      }}
    >
      {LANGUAGES.map((l: Language) => (
        <ToggleGroupItem
          key={l}
          value={l}
          lang={l}
          aria-label={LANGUAGE_NAMES[l]}
          className="h-12 min-w-11 rounded-xl text-[13px] text-muted-foreground uppercase data-[state=on]:bg-surface-raised data-[state=on]:text-foreground data-[state=on]:shadow-soft"
        >
          {l}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  )
}

export function Distintivo({ name }: { name: string }) {
  return (
    <Avatar aria-hidden className="size-11 rounded-2xl after:rounded-2xl">
      <AvatarFallback className="rounded-2xl border bg-surface-raised text-[14px] font-semibold text-[var(--brand-text)]">{initials(name)}</AvatarFallback>
    </Avatar>
  )
}

/**
 * Dentro de un iframe, avisa a la página de fuera de la altura para que no haya barra doble.
 * Recibe el elemento (no una ref) para volver a engancharse si el contenedor cambia, por ejemplo
 * al pasar de «cargando» a la reserva.
 */
function useAlturaParaIframe(enabled: boolean, el: HTMLElement | null) {
  useEffect(() => {
    if (!enabled || !el || window.parent === window) return
    let last = 0
    const send = () => {
      const height = Math.ceil(el.scrollHeight)
      if (height === last) return
      last = height
      window.parent.postMessage({ type: "llenamos:height", height }, "*")
    }
    const observer = new ResizeObserver(send)
    observer.observe(el)
    send()
    return () => observer.disconnect()
  }, [enabled, el])
}

export function PublicShell({
  name,
  brandColor,
  subtitle,
  title,
  children,
  compactHeader = false,
  wide = false,
}: {
  /** Nombre del restaurante, o null si no se conoce (restaurante que no existe). */
  name: string | null
  brandColor: string | null
  subtitle?: string | null
  /** Título del servicio público cuando la página no es de reservas. */
  title?: string
  children: React.ReactNode
  /** Cabecera pequeña (confirmación, gestión): el nombre va arriba a la izquierda. */
  compactHeader?: boolean
  /** Reservas: dos columnas de selección en escritorio. */
  wide?: boolean
}) {
  const { t, lang, variant } = usePublic()
  const [shell, setShell] = useState<HTMLDivElement | null>(null)
  const widget = variant === "widget"
  const marca = useMemo(() => brandStyle(brandColor) as React.CSSProperties, [brandColor])
  useAlturaParaIframe(widget, shell)

  return (
    <MarcaContext.Provider value={marca}>
      <div
        ref={setShell}
        lang={lang}
        style={marca}
        className={cn(
          styles.publica,
          "mx-auto flex w-full min-w-0 flex-col px-4 sm:px-6",
          widget ? "max-w-[640px] py-4" : "min-h-dvh max-w-[1088px] pt-5 sm:pt-8",
        )}
      >
        <div className="flex items-center justify-between gap-3 border-b pb-4 sm:pb-5">
          <div className="flex min-w-0 items-center gap-3">
            {name ? <Distintivo name={name} /> : null}
            {name ? <span className="min-w-0 text-sm font-medium leading-snug text-soft-foreground">{name}</span> : null}
          </div>
          <SelectorIdioma />
        </div>

        <div className="flex flex-1 flex-col gap-5 pt-6 sm:gap-6 sm:pt-8">
          {!compactHeader && name ? (
            <header className={cn("flex min-w-0 flex-col gap-2", !wide && "mx-auto w-full max-w-[640px]")}>
              <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">
                {title ?? t("metaTitle", { name })}
              </h1>
              {subtitle ? <p className="text-sm text-muted-foreground">{subtitle}</p> : null}
            </header>
          ) : null}
          <main className={cn("flex min-w-0 flex-1 flex-col", (!wide || widget) && "mx-auto w-full max-w-[640px]")}>{children}</main>
        </div>

        {widget ? null : (
          <footer className="py-6 text-center text-xs text-muted-foreground sm:py-8">
            {t("poweredBy")} <span className="font-medium text-soft-foreground">llenamos</span>
          </footer>
        )}
      </div>
    </MarcaContext.Provider>
  )
}
