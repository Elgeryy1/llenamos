import { PURCHASE_STATUS_LABEL, type PurchaseStatus } from "@llenamos/core"
import { cn } from "@/lib/cn"

const ASPECTO: Record<PurchaseStatus, { text: string; dot: string }> = {
  draft: { text: "text-soft-foreground", dot: "border-muted-foreground bg-transparent border-dashed" },
  sent: { text: "text-soft-foreground", dot: "border-muted-foreground bg-muted-foreground" },
  partially_received: { text: "text-warning", dot: "border-warning bg-warning" },
  received: { text: "text-success", dot: "border-success bg-success" },
  cancelled: { text: "text-destructive", dot: "border-destructive bg-transparent" },
  closed: { text: "text-muted-foreground", dot: "border-ash bg-ash" },
}

/** Estado de un pedido: punto de 8 px y palabra, nunca solo color. */
export function EstadoPedido({ status, className }: { status: PurchaseStatus; className?: string }) {
  const a = ASPECTO[status]
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap", a.text, className)}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full border", a.dot)} />
      {PURCHASE_STATUS_LABEL[status]}
    </span>
  )
}
