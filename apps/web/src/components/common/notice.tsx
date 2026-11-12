import { CheckCircleIcon, InfoIcon, WarningCircleIcon, WarningIcon } from "@phosphor-icons/react/dist/ssr"
import type { ReactNode } from "react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { cn } from "@/lib/cn"

export type NoticeTone = "error" | "warning" | "info" | "success"

const tones: Record<NoticeTone, string> = {
  error: "border-destructive/35 text-destructive",
  warning: "border-warning/35 text-warning",
  info: "",
  success: "border-success/35 text-success",
}

const icons: Record<NoticeTone, ReactNode> = {
  error: <WarningCircleIcon aria-hidden weight="fill" />,
  warning: <WarningIcon aria-hidden weight="fill" />,
  info: <InfoIcon aria-hidden weight="fill" className="text-muted-foreground" />,
  success: <CheckCircleIcon aria-hidden weight="fill" />,
}

/**
 * Aviso dentro de la página, sobre el Alert de shadcn. Los errores se anuncian enseguida
 * (role="alert"); el resto con educación (role="status"). Para avisos que se van solos
 * tras una acción, mejor un toast (sonner).
 */
export function Notice({
  tone = "info",
  title,
  children,
  action,
  detail,
  className,
}: {
  tone?: NoticeTone
  title?: ReactNode
  children?: ReactNode
  /** Botón para reintentar o resolver el problema. */
  action?: ReactNode
  /** Código técnico pequeño, para quien tenga que arreglarlo. */
  detail?: string
  className?: string
}) {
  return (
    <Alert role={tone === "error" ? "alert" : "status"} className={cn(tones[tone], className)}>
      {icons[tone]}
      {title ? <AlertTitle>{title}</AlertTitle> : null}
      {children || detail || action ? (
        <AlertDescription className="text-muted-foreground">
          {children}
          {detail ? <p className="cifra text-xs text-muted-foreground/80">{detail}</p> : null}
          {action ? <div className="mt-2 flex flex-wrap gap-2">{action}</div> : null}
        </AlertDescription>
      ) : null}
    </Alert>
  )
}
