"use client"

import { Kbd, KbdGroup } from "@/components/ui/kbd"
import { cn } from "@/lib/cn"
import { useIsMac } from "./hotkeys"

const LABEL: Record<string, string> = {
  enter: "↵",
  arrowleft: "←",
  arrowright: "→",
  arrowup: "↑",
  arrowdown: "↓",
  escape: "Esc",
  shift: "⇧",
}

/**
 * Teclas de un atajo con el Kbd de shadcn, en la capa hundida de la sala cálida: «mod k»
 * se lee ⌘K en Mac y Ctrl K en el resto.
 */
export function Keys({ keys, className, then }: { keys: readonly string[]; className?: string; then?: boolean }) {
  const mac = useIsMac()
  return (
    <KbdGroup className={cn("shrink-0", className)} aria-hidden>
      {keys.map((k, i) => (
        <span key={`${k}-${i}`} className="inline-flex items-center gap-1">
          {then && i > 0 ? <span className="text-[10px] text-muted-foreground">luego</span> : null}
          <Kbd className="cifra h-5 min-w-5 rounded-[5px] border border-border bg-surface-sunken/70 px-1 text-[11px] font-normal text-soft-foreground shadow-[inset_0_-1px_0_0_rgb(0_0_0/0.35)]">
            {k === "mod" ? (mac ? "⌘" : "Ctrl") : (LABEL[k] ?? k.toUpperCase())}
          </Kbd>
        </span>
      ))}
    </KbdGroup>
  )
}
