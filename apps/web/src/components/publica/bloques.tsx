"use client"

/**
 * Bloques propios de la web pública, montados sobre los componentes de `components/ui`
 * (shadcn). Lo demás (botones, campos, avisos, diálogos) se usa directamente de `ui/` y
 * `common/`, como dice docs/diseno/componentes.md.
 */
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/cn"
import { usePublic } from "./PublicContext"

/** Spinner dentro de un botón ocupado: no se anuncia, el texto del botón ya cambia. */
export function Ocupado({ busy }: { busy: boolean }) {
  return busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null
}

/* Opciones (local, personas, día, hora) ---------------------------------------
 * ToggleGroup de shadcn en modo `single`: se recorre con las flechas y nunca se queda sin
 * opción al volver a pulsar la elegida. La elegida lleva el color del restaurante.
 */

export function Opciones({
  labelledBy,
  value,
  onChange,
  className,
  children,
}: {
  /** Id del título que da nombre al grupo. */
  labelledBy: string
  value: string
  onChange: (value: string) => void
  className?: string
  children: React.ReactNode
}) {
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      aria-labelledby={labelledBy}
      value={value}
      onValueChange={(next) => {
        if (next) onChange(next)
      }}
      className={cn("w-full", className)}
    >
      {children}
    </ToggleGroup>
  )
}

export function Opcion({ className, ...props }: React.ComponentProps<typeof ToggleGroupItem>) {
  return (
    <ToggleGroupItem
      className={cn(
        "cifra h-12 min-w-0 rounded-2xl bg-surface-sunken px-0 text-[15px] text-soft-foreground shadow-soft",
        "data-[state=on]:border-[var(--brand-text)] data-[state=on]:bg-surface-raised data-[state=on]:text-[var(--brand-text)] hover:data-[state=on]:bg-surface-raised hover:data-[state=on]:text-[var(--brand-text)]",
        // Completa o fuera de plazo: tachada y apagada, sin usar el color ceniza en texto.
        "disabled:bg-transparent disabled:text-muted-foreground disabled:line-through disabled:opacity-60",
        className,
      )}
      {...props}
    />
  )
}

/* Bloques -------------------------------------------------------------------- */

export function Seccion({ title, id, children, className }: { title: string; id: string; children: React.ReactNode; className?: string }) {
  return (
    <section aria-labelledby={id} className={cn("superficie flex min-w-0 flex-col gap-3.5 rounded-2xl p-4 sm:p-5", className)}>
      <h2 id={id} className="text-base font-semibold text-foreground">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** Barra fija abajo con el resumen y el botón principal (el pulgar llega sin estirarse). */
export function BarraInferior({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 mt-auto flex flex-col gap-2 rounded-t-2xl border bg-card px-4 pt-3.5 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-soft sm:px-5">
      {children}
    </div>
  )
}

/** Campo trampa para robots: fuera de la vista, del teclado y de los lectores de pantalla. */
export function CampoTrampa({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <div aria-hidden className="absolute -left-[9999px] h-px w-px overflow-hidden">
      <label>
        Website
        <input type="text" name="website" tabIndex={-1} autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      </label>
    </div>
  )
}

/** Enlace que parece texto con el color legible de la marca (llamar, mapa, lista de espera). */
export const ENLACE = "inline-flex min-h-11 items-center gap-1.5 text-[var(--brand-text)] underline-offset-4 hover:underline"

/** «Correo (opcional)» con la parte opcional más apagada. */
export function Opcional({ label }: { label: string }) {
  const { t } = usePublic()
  return (
    <span>
      {label} <span className="font-normal text-muted-foreground">({t("optional")})</span>
    </span>
  )
}
