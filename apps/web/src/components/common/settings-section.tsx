import type { ReactNode } from "react"

/** Superficie de ajustes: cabecera separada y campos agrupados sin tarjetas anidadas. */
export function SettingsSection({ id, title, description, children, action }: { id: string; title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-titulo`} id={id} className="superficie min-w-0 scroll-mt-24 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1 basis-56">
          <h2 id={`${id}-titulo`} className="text-base font-semibold">{title}</h2>
          {description ? <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
        </div>
        {action}
      </div>
      <div className="flex min-w-0 flex-col gap-5 p-4 sm:p-5">{children}</div>
    </section>
  )
}
