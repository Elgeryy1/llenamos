import type * as React from "react"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/cn"

/**
 * Etiqueta pequeña de una reserva o un cliente (11,5 px, alto 18, radio 4), sobre el
 * Badge de shadcn. `alergia` en rojo suave, `habitual` en verde suave, `aviso` en ámbar
 * («Sin mesa») y `neutro` para todo lo demás («Cumpleaños», «Señal 30 €»).
 */
export type TagTone = "neutro" | "alergia" | "habitual" | "aviso"

const tones: Record<TagTone, string> = {
  neutro: "bg-foreground/[0.07] text-soft-foreground",
  alergia: "bg-destructive/12 text-[#f1a79e]",
  habitual: "bg-success/10 text-[#a8d4b5]",
  aviso: "bg-warning/14 text-warning",
}

export function Tag({ tone = "neutro", className, ...props }: React.ComponentProps<typeof Badge> & { tone?: TagTone }) {
  return (
    <Badge
      variant="secondary"
      data-tone={tone}
      className={cn("h-[18px] rounded-sm px-1.5 text-[11.5px] font-normal", tones[tone], className)}
      {...props}
    />
  )
}
