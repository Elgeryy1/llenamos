import { cn } from "@/lib/utils"

/** Marca: una mesa vista desde arriba con cuatro sillas, y el nombre. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true" className={cn("size-6", className)}>
      <rect x="9" y="9" width="14" height="14" rx="4" fill="#f0a35e" />
      <rect x="13" y="2" width="6" height="4" rx="2" fill="#f4f1ea" />
      <rect x="13" y="26" width="6" height="4" rx="2" fill="#f4f1ea" />
      <rect x="2" y="13" width="4" height="6" rx="2" fill="#f4f1ea" />
      <rect x="26" y="13" width="4" height="6" rx="2" fill="#f4f1ea" />
    </svg>
  )
}

/** Logo completo. `by` añade la firma «by LogiQD» (en móvil se oculta en el menú). */
export function Logo({ className, by = false }: { className?: string; by?: boolean }) {
  return (
    <span className={cn("flex items-center gap-2", className)}>
      <LogoMark />
      <span className="text-base font-semibold tracking-tight">llenamos</span>
      {by && <span className="hidden text-xs text-dim sm:inline">by LogiQD</span>}
    </span>
  )
}
