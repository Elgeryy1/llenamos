import { localize, PUBLIC_LINE_STATUS_TEXT, type Language, type PublicOrderLine } from "@llenamos/core"
import { publicText } from "@/lib/mesa-publica/textos"
import { euros } from "@/lib/carta/forms"
export function OrderLines({ lines, lang, takeaway = false }: { lines: PublicOrderLine[]; lang: Language; takeaway?: boolean }) {
  const statusText = (status: PublicOrderLine["status"]) => takeaway && status === "on_its_way" ? publicText(lang, "ready") : PUBLIC_LINE_STATUS_TEXT[lang][status]
  return (
    <ul className="divide-y">
      {lines.map((l) => (
        <li key={l.id} className="space-y-2 py-4">
          <div className="flex justify-between gap-4">
            <span>
              {l.quantity} × {localize(l.name, lang)}
            </span>
            <span className="cifra whitespace-nowrap">{euros(l.totalCents, lang)}</span>
          </div>
          <p className="text-xs text-muted-foreground">
            {[l.variant, ...l.modifiers]
              .filter((x) => x !== null)
              .map((x) => localize(x!, lang))
              .join(", ")}
          </p>
          <p className="text-sm text-warning">{statusText(l.status)}</p>
          {l.components.length > 0 && (
            <ul className="space-y-2 pl-3 text-sm text-muted-foreground">
              {l.components.map((c, i) => (
                <li key={i}>
                  {localize(c.name, lang)}
                  {c.variant && ` · ${localize(c.variant, lang)}`}
                  {c.modifiers.map((m, j) => (
                    <span key={j}> · {localize(m, lang)}</span>
                  ))}{" "}
                  · {statusText(c.status)}
                </li>
              ))}
            </ul>
          )}
        </li>
      ))}
    </ul>
  )
}
