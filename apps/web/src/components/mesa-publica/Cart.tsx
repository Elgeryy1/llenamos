"use client"
import {
  localize, orderPriceSignature,
  menuUi,
  ORDER_PROBLEM_TEXT,
  type Language,
  type OrderLineInput,
  type PublicMenu,
} from "@llenamos/core"
import { Button } from "@/components/ui/button"
import { TextareaField } from "@/components/common/form-fields"
import { euros } from "@/lib/carta/forms"
import { reviewOrder } from "@/lib/mesa-publica/pedido"
import { useState } from "react"
export function Cart({
  menu,
  lang,
  channel,
  at,
  lines,
  onChange,
  pending,
  blocked,
  onSend,
  children,
  revision = 0,
  draftNote, onNoteChange,
}: {
  draftNote?: string
  onNoteChange?: (note: string) => void
  revision?: number
  menu: PublicMenu
  lang: Language
  channel: "table" | "takeaway"
  at: number
  lines: OrderLineInput[]
  onChange: (v: OrderLineInput[]) => void
  pending: boolean
  blocked: boolean
  onSend: (total: number, note: string) => void
  children?: React.ReactNode
}) {
  const [reviewed, setReviewed] = useState<{ fingerprint: string; total: number } | null>(null)
  const [localNote, setLocalNote] = useState("")
  const note = draftNote ?? localNote
  const setNote = onNoteChange ?? setLocalNote
  if (lines.length === 0) return null
  let prices = ""
  let total = 0,
    problems: string[] = []
  try {
    const p = reviewOrder(menu, lines, channel, at)
    total = p.totalCents
    prices = orderPriceSignature(p.lines)
    problems = p.ok ? [] : p.problems.map((p) => ORDER_PROBLEM_TEXT[lang][p.code])
  } catch (e) {
    problems = [e instanceof Error ? e.message : menuUi(lang, "orderRejected")]
  }
  const fingerprint = `${revision}:${JSON.stringify(lines)}:${prices}`
  const agreed = reviewed?.fingerprint === fingerprint && reviewed.total === total
  return (
    <section
      id="pedido-publico"
      className="superficie my-6 scroll-mt-20 space-y-4 p-4"
      aria-label={menuUi(lang, "yourOrder")}
    >
      <h2 className="text-xl font-semibold">{menuUi(lang, "yourOrder")}</h2>
      <ul className="divide-y">
        {lines.map((line, index) => {
          const item =
            line.kind === "item"
              ? menu.items.find((i) => i.id === line.itemId)
              : menu.dailyMenus.find((i) => i.id === line.dailyMenuId)
          return (
            <li key={index} className="space-y-2 py-3">
              <div className="flex items-center justify-between gap-3">
                <span>
                  {line.quantity} × {item ? localize(item.name, lang) : "?"}
                </span>
                <Button
                  className="h-12"
                  disabled={pending || blocked}
                  variant="ghost"
                  onClick={() => onChange(lines.filter((_, n) => n !== index))}
                >
                  {menuUi(lang, "remove")}
                </Button>
              </div>
              {line.kind === "item" && (
                <p className="text-xs text-muted-foreground">
                  {menu.items
                    .find((i) => i.id === line.itemId)
                    ?.variants.filter((v) => v.id === line.variantId)
                    .map((v) => localize(v.name, lang))
                    .join(", ")}
                  {menu.items
                    .find((i) => i.id === line.itemId)
                    ?.modifierGroups.flatMap((g) => g.options)
                    .filter((o) => line.optionIds.includes(o.id))
                    .map((o) => ` · ${localize(o.name, lang)}`)
                    .join("")}
                </p>
              )}
              {line.kind === "menu" && (
                <ul className="space-y-1 text-xs text-muted-foreground">
                  {line.selections.map((s, i) => (
                    <li key={i}>
                      {localize(menu.items.find((x) => x.id === s.itemId)?.name ?? { es: "?", ca: "", en: "" }, lang)}
                      {s.notes && ` · ${s.notes}`}
                    </li>
                  ))}
                </ul>
              )}
              {line.notes && <p className="text-xs text-muted-foreground">{line.notes}</p>}
            </li>
          )
        })}
      </ul>
      <div className="flex justify-between border-t pt-4 font-semibold">
        <span>{menuUi(lang, "total")}</span>
        <span className="cifra">{euros(total, lang)}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {menuUi(lang, "vatIncluded")}.{" "}
        {lang === "en"
          ? "The server checks the final price before sending."
          : lang === "ca"
            ? "El servidor comprova el preu final abans d'enviar."
            : "El servidor comprueba el precio final antes de enviar."}
      </p>
      {problems.length > 0 && (
        <ul role="alert" className="text-sm text-warning">
          {[...new Set(problems)].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <TextareaField
        label={menuUi(lang, "notes")}
        maxLength={200}
        value={note}
        disabled={pending || blocked}
        onChange={(e) => setNote(e.target.value)}
      />
      {children}
      {!agreed && (
        <Button
          variant="outline"
          className="h-12 w-full"
          disabled={pending || blocked || problems.length > 0}
          onClick={() => setReviewed({ fingerprint, total })}
        >
          {lang === "en" ? "Review total" : lang === "ca" ? "Revisar el total" : "Revisar el total"} ·{" "}
          {euros(total, lang)}
        </Button>
      )}
      <Button
        className="h-12 w-full"
        disabled={pending || blocked || !agreed || problems.length > 0}
        onClick={() => onSend(total, note)}
      >
        {pending ? "…" : menuUi(lang, "sendOrder")}
      </Button>
    </section>
  )
}
