// Bloque login-04 de shadcn: tarjeta en dos columnas. A la izquierda el formulario; a la
// derecha, en vez de la imagen del bloque, lo que toque (las cuentas de demostración).
import Link from "next/link"
import type { ReactNode } from "react"
import { Wordmark } from "@/components/Wordmark"
import { cn } from "@/lib/cn"

export function LoginLayout({ children, aside, footer }: { children: ReactNode; aside?: ReactNode; footer?: ReactNode }) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-4 sm:p-6 md:p-10">
      <Link href="/" className="inline-flex min-h-11 items-center rounded-md text-foreground">
        <Wordmark withBy />
      </Link>
      <div className={cn("w-full", aside ? "max-w-lg md:max-w-5xl" : "max-w-sm")}>
        <div className="flex flex-col gap-6">
          <div className="superficie overflow-hidden">
            <div className={cn("grid", aside && "md:grid-cols-[1fr_1.15fr]")}>
              <div className="p-6 md:p-10">{children}</div>
              {aside ? <div className="border-t bg-surface-sunken/50 p-6 md:border-t-0 md:border-l md:p-8">{aside}</div> : null}
            </div>
          </div>
          {footer ? <div className="px-6 text-center text-xs text-muted-foreground">{footer}</div> : null}
        </div>
      </div>
    </div>
  )
}
