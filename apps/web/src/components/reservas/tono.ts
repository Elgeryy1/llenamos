import type { StatusTone } from "@/lib/reservas/estados"

/**
 * Cómo se pinta cada estado en la línea de tiempo (de la propuesta A, con los colores de
 * la sala cálida de B): una barra de color a la izquierda y un fondo suave del mismo tono
 * que la mesa en el plano. El color nunca va solo: al lado
 * siempre está la palabra del estado (lista) o se dice en la etiqueta del bloque.
 */
export const TONE_BAR: Record<StatusTone, string> = {
  waiting: "bg-muted-foreground/70",
  pending: "bg-warning/60",
  late: "bg-warning",
  seated: "bg-success",
  finished: "bg-ash",
  cancelled: "bg-destructive/70",
}

export const TONE_BLOCK: Record<StatusTone, string> = {
  waiting: "border-foreground/16 bg-surface-raised text-foreground hover:border-foreground/35",
  pending: "border-dashed border-warning/60 bg-warning/[0.06] text-foreground hover:border-warning",
  late: "border-warning/70 bg-warning/[0.13] text-foreground hover:border-warning",
  seated: "border-success/50 bg-success/[0.11] text-foreground hover:border-success/80",
  finished: "border-foreground/[0.06] bg-foreground/[0.03] text-muted-foreground shadow-none hover:border-foreground/20",
  cancelled: "border-destructive/30 bg-transparent text-muted-foreground line-through shadow-none",
}
