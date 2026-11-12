import type { ReactNode } from "react"

/** Cabecera cálida: contexto, titular y una acción principal. */
export function PageHeading({ title, eyebrow, description, actions }: {
  title: string
  eyebrow?: ReactNode
  description?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-4 sm:mb-6">
      <div className="min-w-0 flex-1 basis-72">
        {eyebrow ? <p className="mb-1.5 text-[13px] text-muted-foreground sm:text-sm">{eyebrow}</p> : null}
        <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">{title}</h1>
        {description ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-3 max-sm:w-full [&_button]:shadow-soft">{actions}</div> : null}
    </header>
  )
}
