import type { ReactNode } from "react"
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

/** Bloque del formulario (Card de shadcn) con su título y una frase que explica para qué sirve. */
export function Section({ id, title, description, children, action }: { id: string; title: string; description?: ReactNode; children: ReactNode; action?: ReactNode }) {
  return (
    <Card role="region" aria-labelledby={`${id}-titulo`} id={id} className="scroll-mt-20">
      <CardHeader>
        <CardTitle>
          <h2 id={`${id}-titulo`}>{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {action ? <CardAction>{action}</CardAction> : null}
      </CardHeader>
      <CardContent className="flex flex-col gap-5">{children}</CardContent>
    </Card>
  )
}
