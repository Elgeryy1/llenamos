"use client"

/**
 * Paleta de órdenes del panel (⌘K o Ctrl K), sobre el Command de shadcn (cmdk).
 *
 * El armazón pone lo común (ir a cada sección, cambiar de local, atajos, salir) y cada
 * página añade lo suyo con `useRegisterCommands`: las reservas del día, «Nueva reserva»,
 * cambiar de vista… Cuando Next oculta la página, su efecto se limpia y sus órdenes
 * desaparecen de la paleta.
 */
import { restaurantModules } from "@llenamos/core"
import {
  ArrowRightIcon,
  KeyboardIcon,
  SidebarSimpleIcon,
  SignOutIcon,
  StorefrontIcon,
} from "@phosphor-icons/react"
import { useRouter } from "next/navigation"
import { createContext, use, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { useSidebar } from "@/components/ui/sidebar"
import { signOut } from "@/lib/auth/AuthProvider"
import { useCloseOnHide } from "@/lib/open-state"
import { navForRole, type PanelSection } from "@/lib/panel/nav"
import { isTyping, overlayOpen, useHotkeys } from "./hotkeys"
import { Keys } from "./Keys"

export interface PanelCommand {
  id: string
  label: string
  /** Texto apagado a la derecha del nombre («20:30 · 4 pers. · S4»). */
  hint?: ReactNode
  /** Palabras extra para la búsqueda (teléfono, referencia, mesa). */
  keywords?: string[]
  icon?: ReactNode
  /** Atajo que se enseña («n», o «mod k»). Solo se enseña: lo escucha la página. */
  shortcut?: string[]
  onSelect: () => void
}

export interface PanelCommandGroup {
  id: string
  heading: string
  commands: PanelCommand[]
}

/** Atajos «G y luego una letra» para ir a cada sección. */
export const GO_KEYS: Partial<Record<PanelSection, string>> = {
  inicio: "i",
  reservas: "r",
  sala: "s",
  "lista-espera": "e",
  clientes: "c",
  mensajes: "m",
  plano: "p",
  horarios: "h",
  actividad: "a",
  equipo: "q",
}

interface CommandsContextValue {
  register: (source: string, groups: PanelCommandGroup[]) => void
  unregister: (source: string) => void
  openPalette: () => void
  openHelp: () => void
}

const CommandsContext = createContext<CommandsContextValue | null>(null)

/** Añade órdenes a la paleta mientras la página está a la vista. `groups` debe ir memorizado. */
export function useRegisterCommands(source: string, groups: PanelCommandGroup[]) {
  const ctx = use(CommandsContext)
  useEffect(() => {
    if (!ctx) return
    ctx.register(source, groups)
    return () => ctx.unregister(source)
  }, [ctx, source, groups])
}

export function useCommandPalette() {
  const ctx = use(CommandsContext)
  return { open: ctx?.openPalette ?? (() => {}), help: ctx?.openHelp ?? (() => {}) }
}

export function PanelCommands({ icons, children }: { icons: Partial<Record<PanelSection, ReactNode>>; children: ReactNode }) {
  const router = useRouter()
  const { role, restaurant, restaurants, locations, location, selectLocation, selectRestaurant } = usePanel()
  const { toggleSidebar } = useSidebar()
  const [sources, setSources] = useState<ReadonlyMap<string, PanelCommandGroup[]>>(new Map())
  const [open, setOpen] = useState(false)
  const [help, setHelp] = useState(false)
  useCloseOnHide(() => {
    setOpen(false)
    setHelp(false)
  })

  const register = useCallback((source: string, groups: PanelCommandGroup[]) => {
    setSources((prev) => new Map(prev).set(source, groups))
  }, [])
  const unregister = useCallback((source: string) => {
    setSources((prev) => {
      if (!prev.has(source)) return prev
      const next = new Map(prev)
      next.delete(source)
      return next
    })
  }, [])
  const ctx = useMemo<CommandsContextValue>(
    () => ({ register, unregister, openPalette: () => setOpen(true), openHelp: () => setHelp(true) }),
    [register, unregister],
  )

  const nav = navForRole(role, restaurantModules(restaurant))

  // ⌘K / Ctrl K abre y cierra la paleta; «?» abre los atajos.
  useHotkeys({
    "mod+k": () => setOpen((o) => !o),
    "?": () => setHelp(true),
  })

  // «G» y luego una letra: ir a una sección.
  const goPending = useRef<number | null>(null)
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey || e.defaultPrevented) return
      if (isTyping(e.target) || overlayOpen()) return
      const key = e.key.toLowerCase()
      if (goPending.current !== null) {
        window.clearTimeout(goPending.current)
        goPending.current = null
        const item = nav.find((i) => GO_KEYS[i.section] === key)
        if (item) {
          e.preventDefault()
          router.push(item.href)
        }
        return
      }
      if (key === "g") goPending.current = window.setTimeout(() => (goPending.current = null), 1200)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [nav, router])

  const run = (fn: () => void) => {
    setOpen(false)
    // Se espera a que la paleta se cierre para que el foco no vuelva encima de lo que se abre.
    window.setTimeout(fn, 0)
  }

  const pageGroups = [...sources.values()].flat()
  const pageShortcuts = pageGroups.flatMap((g) => g.commands.filter((c) => c.shortcut))

  return (
    <CommandsContext value={ctx}>
      {children}
      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Buscar o ir a"
        description="Busca reservas, ve a otra sección o haz una acción rápida."
        className="max-w-[calc(100%-2rem)] rounded-[14px]! border bg-popover shadow-float sm:max-w-xl"
      >
        <Command filter={filterCommands} className="rounded-[14px]!">
        <CommandInput placeholder="Busca una reserva, una sección o una acción…" />
        <CommandList className="max-h-[min(26rem,60vh)]">
          <CommandEmpty>Nada con ese nombre.</CommandEmpty>
          {pageGroups.map((g) => (
            <CommandGroup key={g.id} heading={g.heading}>
              {g.commands.map((c) => (
                <CommandItem key={c.id} value={`${g.id}:${c.id}`} keywords={[c.label, ...(c.keywords ?? [])]} onSelect={() => run(c.onSelect)}>
                  {c.icon}
                  <span className="truncate">{c.label}</span>
                  {c.hint ? <span className="cifra truncate text-xs text-muted-foreground">{c.hint}</span> : null}
                  {c.shortcut ? (
                    <CommandShortcut>
                      <Keys keys={c.shortcut} />
                    </CommandShortcut>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ))}
          {pageGroups.length > 0 ? <CommandSeparator /> : null}
          <CommandGroup heading="Ir a">
            {nav.map((item) => (
              <CommandItem key={item.href} value={`ir:${item.href}`} keywords={[item.label, "ir"]} onSelect={() => run(() => router.push(item.href))}>
                {icons[item.section] ?? <ArrowRightIcon />}
                <span>{item.label}</span>
                {GO_KEYS[item.section] ? (
                  <CommandShortcut>
                    <Keys keys={["g", GO_KEYS[item.section]!]} />
                  </CommandShortcut>
                ) : null}
              </CommandItem>
            ))}
          </CommandGroup>
          {locations.length > 1 || restaurants.length > 1 ? (
            <CommandGroup heading="Cambiar de local">
              {locations
                .filter((l) => l.id !== location?.id)
                .map((l) => (
                  <CommandItem key={l.id} value={`local:${l.id}`} keywords={[l.name, "local"]} onSelect={() => run(() => selectLocation(l.id))}>
                    <StorefrontIcon />
                    <span>{l.name}</span>
                  </CommandItem>
                ))}
              {restaurants
                .filter((r) => r.id !== restaurant.id)
                .map((r) => (
                  <CommandItem key={r.id} value={`restaurante:${r.id}`} keywords={[r.name, "restaurante"]} onSelect={() => run(() => selectRestaurant(r.id))}>
                    <StorefrontIcon />
                    <span>{r.name}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          ) : null}
          <CommandGroup heading="General">
            <CommandItem value="general:atajos" keywords={["atajos", "teclado", "ayuda"]} onSelect={() => run(() => setHelp(true))}>
              <KeyboardIcon />
              <span>Atajos de teclado</span>
              <CommandShortcut>
                <Keys keys={["?"]} />
              </CommandShortcut>
            </CommandItem>
            <CommandItem value="general:menu" keywords={["menú", "barra lateral", "plegar"]} onSelect={() => run(toggleSidebar)}>
              <SidebarSimpleIcon />
              <span>Plegar o abrir el menú</span>
              <CommandShortcut>
                <Keys keys={["mod", "b"]} />
              </CommandShortcut>
            </CommandItem>
            <CommandItem value="general:salir" keywords={["salir", "cerrar sesión"]} onSelect={() => run(() => void signOut())}>
              <SignOutIcon />
              <span>Salir</span>
            </CommandItem>
          </CommandGroup>
        </CommandList>
        <div className="flex items-center gap-4 border-t bg-card/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <Keys keys={["arrowup"]} />
            <Keys keys={["arrowdown"]} /> moverse
          </span>
          <span className="flex items-center gap-1.5">
            <Keys keys={["enter"]} /> abrir
          </span>
          <span className="ml-auto flex items-center gap-1.5">
            <Keys keys={["escape"]} /> cerrar
          </span>
        </div>
        </Command>
      </CommandDialog>

      <Dialog open={help} onOpenChange={setHelp}>
        <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto rounded-[14px] bg-popover shadow-float sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Atajos de teclado</DialogTitle>
            <DialogDescription>Funcionan cuando no estás escribiendo en un campo.</DialogDescription>
          </DialogHeader>
          <ShortcutList
            title="En todo el panel"
            rows={[
              { label: "Buscar o ir a", keys: ["mod", "k"] },
              { label: "Ver los atajos", keys: ["?"] },
              { label: "Plegar el menú", keys: ["mod", "b"] },
              ...nav.filter((i) => GO_KEYS[i.section]).map((i) => ({ label: `Ir a ${i.label.toLowerCase()}`, keys: ["g", GO_KEYS[i.section]!], then: true })),
            ]}
          />
          {pageShortcuts.length > 0 ? (
            <ShortcutList title="En esta pantalla" rows={[
              ...pageShortcuts.map((c) => ({ label: c.label, keys: c.shortcut! })),
              ...(sources.has("reservas") ? [
                { label: "Abrir o elegir la fila con foco", keys: ["enter"] },
                { label: "Quitar la reserva elegida", keys: ["escape"] },
                { label: "Acción principal en el detalle o la vista partida", keys: ["mod", "enter"] },
              ] : []),
            ]} />
          ) : null}
        </DialogContent>
      </Dialog>
    </CommandsContext>
  )
}

/** Minúsculas y sin acentos: «ivan» encuentra «Iván». */
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()

/**
 * Filtro de la paleta: busca el texto entero (no letras sueltas) en el nombre y las
 * palabras clave, sin acentos. Primero lo que empieza igual, luego lo que empieza una
 * palabra y al final lo que lo contiene.
 */
export function filterCommands(_value: string, search: string, keywords?: string[]): number {
  const q = fold(search).trim()
  if (q === "") return 1
  const hay = (keywords ?? []).map(fold)
  if (hay[0]?.startsWith(q)) return 1
  if (hay.some((h) => h.split(/[\s·.,]+/).some((w) => w.startsWith(q)))) return 0.8
  if (hay.some((h) => h.includes(q))) return 0.5
  const digits = q.replace(/\D/g, "")
  if (digits.length >= 3 && hay.some((h) => h.replace(/\D/g, "").includes(digits))) return 0.4
  return 0
}

function ShortcutList({ title, rows }: { title: string; rows: Array<{ label: string; keys: string[]; then?: boolean }> }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-[10px] border bg-card shadow-soft">
        {rows.map((r) => (
          <li key={r.label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
            <span>{r.label}</span>
            <Keys keys={r.keys} then={r.then} />
          </li>
        ))}
      </ul>
    </section>
  )
}
