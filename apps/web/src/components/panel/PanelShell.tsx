"use client"

import { MagnifyingGlassIcon, QuestionIcon } from "@phosphor-icons/react"
import { usePathname } from "next/navigation"
import { useEffect, type CSSProperties, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarInset, SidebarProvider, SidebarTrigger, useSidebar } from "@/components/ui/sidebar"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/cn"
import { navItemFor } from "@/lib/panel/nav"
import { timeOf } from "@/lib/reservas/formato"
import { useNow } from "@/lib/reservas/hooks"
import { PanelCommands, useCommandPalette } from "./command/commands"
import { AvisosMovil } from "@/components/avisos/AvisosMovil"
import { Keys } from "./command/Keys"
import { usePanel } from "./PanelContext"
import { AppSidebar, ICONS } from "./sidebar/app-sidebar"

/** Páginas del servicio que necesitan todo el ancho (el plano y la lista del día). */
const WIDE = ["/panel/sala", "/panel/reservas", "/panel/cocina", "/panel/barra"]

/** «lun 9 nov» en la zona del restaurante. */
function shortToday(now: number, timezone: string) {
  return new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short", timeZone: timezone })
    .format(now)
    .replace(/\./g, "")
    .replace(",", "")
}

/**
 * Cabecera fija (parte del bloque site-header de dashboard-01): abrir el menú, dónde estás,
 * el buscador de la paleta (Ctrl K o ⌘K, de la propuesta A) y, a la derecha, el reloj del
 * servicio con la hora del restaurante, como en el pase.
 */
function SiteHeader() {
  const pathname = usePathname()
  const { restaurant, location } = usePanel()
  const section = navItemFor(pathname)
  const palette = useCommandPalette()
  const now = useNow()
  const tz = restaurant.timezone
  return (
    <header className="sticky top-0 z-20 flex h-(--header-height) shrink-0 items-center border-b bg-background/90 backdrop-blur-md">
      <div className="flex w-full min-w-0 items-center gap-1 px-4 lg:gap-2 lg:px-6">
        <SidebarTrigger className="-ml-1 pointer-coarse:size-11" aria-label="Abrir o cerrar el menú" />
        <Separator orientation="vertical" className="mx-2 data-[orientation=vertical]:h-4" />
        <p className="min-w-0 truncate text-sm text-muted-foreground">
          <span className="hidden sm:inline">{restaurant.name}</span>
          {location ? <span className="hidden lg:inline"> · {location.name}</span> : null}
          {section ? (
            <>
              <span aria-hidden className="mx-2 hidden text-foreground/25 sm:inline">/</span>
              <span className="font-medium text-foreground">{section.label}</span>
            </>
          ) : null}
        </p>
        <div className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            onClick={palette.open}
            aria-label="Buscar o ir a (Control K)"
            className="h-9 gap-2 rounded-lg border-border bg-card px-2.5 font-normal text-muted-foreground shadow-soft hover:bg-surface-raised hover:text-foreground md:w-60 md:justify-start pointer-coarse:h-11"
          >
            <MagnifyingGlassIcon aria-hidden />
            <span className="hidden md:inline">Buscar o ir a…</span>
            <Keys keys={["mod", "k"]} className="ml-auto hidden md:inline-flex" />
          </Button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" onClick={palette.help} aria-label="Atajos de teclado" className="hidden text-muted-foreground lg:inline-flex">
                <QuestionIcon />
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              Atajos de teclado <Keys keys={["?"]} />
            </TooltipContent>
          </Tooltip>
          <p
            className="flex items-center gap-2.5 rounded-full border bg-card py-1 pr-3 pl-2.5 text-xs text-muted-foreground shadow-soft"
            aria-label={`Hora del restaurante: ${timeOf(now, tz)}`}
          >
            <span aria-hidden className="size-2 rounded-full bg-success ring-3 ring-success/15" />
            <span className="hidden xl:inline">{shortToday(now, tz)}</span>
            <span className="cifra text-sm font-medium text-foreground">{timeOf(now, tz)}</span>
          </p>
        </div>
      </div>
    </header>
  )
}

/**
 * En la tableta apaisada (de 768 a 1279 px) la barra lateral empieza plegada a iconos para
 * dejar sitio a la vista partida (propuesta C). Se abre con el botón de la cabecera y, si
 * la persona la abre, se respeta.
 */
function CollapseOnTablet() {
  const { setOpen } = useSidebar()
  useEffect(() => {
    const w = window.innerWidth
    if (w >= 768 && w < 1280) setOpen(false)
    // Solo al entrar en el panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return null
}

/**
 * Armazón del panel: barra lateral sidebar-07 (se pliega a iconos en escritorio y se
 * abre como panel en el móvil), la paleta de órdenes y el contenido a la derecha.
 */
export function PanelShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const wide = WIDE.some((p) => pathname === p || pathname.startsWith(`${p}/`))
  return (
    <SidebarProvider style={{ "--header-height": "3.5rem" } as CSSProperties}>
      <CollapseOnTablet />
      <PanelCommands icons={ICONS}>
        <AppSidebar />
        <SidebarInset className="min-w-0 bg-background">
          <SiteHeader />
          <div className="flex flex-1 flex-col">
            <div className={cn("mx-auto w-full px-4 py-6 md:px-6 lg:px-8 lg:py-8", wide ? "max-w-[1600px]" : "max-w-6xl")}><AvisosMovil />{children}</div>
          </div>
        </SidebarInset>
      </PanelCommands>
    </SidebarProvider>
  )
}
