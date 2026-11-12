import { cn } from "@/lib/cn"

/** Símbolo de la marca: una mesa vista desde arriba con cuatro sillas (igual que la web de venta). */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg aria-hidden viewBox="0 0 32 32" className={cn("size-6 shrink-0", className)}>
      <rect x="9" y="9" width="14" height="14" rx="4" fill="#f0a35e" />
      <rect x="13" y="2" width="6" height="4" rx="2" fill="#f4f1ea" />
      <rect x="13" y="26" width="6" height="4" rx="2" fill="#f4f1ea" />
      <rect x="2" y="13" width="4" height="6" rx="2" fill="#f4f1ea" />
      <rect x="26" y="13" width="4" height="6" rx="2" fill="#f4f1ea" />
    </svg>
  )
}

/** Logo de Llenamos: el símbolo y el nombre en minúscula; withBy añade «by LogiQD» en apagado. */
export function Wordmark({ className, withBy = false }: { className?: string; withBy?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2 text-foreground", className)}>
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">llenamos</span>
      {withBy ? <span className="text-xs text-muted-foreground">by LogiQD</span> : null}
    </span>
  )
}
