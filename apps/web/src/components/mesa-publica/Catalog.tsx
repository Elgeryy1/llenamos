"use client"
import { useEffect, useRef, useState } from "react"
import {
  ALLERGENS,
  ALLERGEN_LABEL,
  filterPublicMenu,
  type Allergen,
  displayPrice,
  localize,
  menuUi,
  publicMenuSections,
  type Language,
  type OrderLineInput,
  type PublicMenu,
  type PublicMenuItem,
  type PublicDailyMenu,
} from "@llenamos/core"
import { Button } from "@/components/ui/button"
import { TextField, TextareaField, SelectField } from "@/components/common/form-fields"
import { Photo } from "@/components/carta/Photo"
import { euros } from "@/lib/carta/forms"
import { reviewOrder } from "@/lib/mesa-publica/pedido"
import { ORDER_PROBLEM_TEXT } from "@llenamos/core"
import { ItemOptions } from "./Options"

export function Catalog({
  menu,
  language: lang,
  channel,
  at,
  canAdd,
  onAdd,
}: {
  menu: PublicMenu
  language: Language
  channel: "table" | "takeaway"
  at: number
  canAdd: boolean
  onAdd: (line: OrderLineInput) => void
}) {
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("")
  const [excluded, setExcluded] = useState<Allergen[]>([])
  const filtered = filterPublicMenu(menu, lang, search, category, excluded)
  const builder = useRef<HTMLDivElement>(null)
  const [selection, setSelection] = useState<PublicMenuItem | PublicDailyMenu | null>(null)
  useEffect(() => {
    if (selection) builder.current?.scrollIntoView?.({ behavior: "smooth", block: "start" })
  }, [selection])
  return (
    <div className="space-y-6">
      <section className="superficie space-y-4 p-4" aria-label={menuUi(lang, "search")}>
        <TextField
          className="h-12"
          type="search"
          label={menuUi(lang, "search")}
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setSelection(null)
          }}
        />
        <SelectField
          className="h-12"
          label={menuUi(lang, "category")}
          value={category}
          onChange={(e) => {
            setCategory(e.target.value)
            setSelection(null)
          }}
        >
          <option value="">{menuUi(lang, "allCategories")}</option>
          {menu.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {localize(c.name, lang)}
            </option>
          ))}
        </SelectField>
        <details>
          <summary className="flex min-h-12 cursor-pointer items-center text-sm font-medium">
            {menuUi(lang, "excludeAllergens")} · {excluded.length}
          </summary>
          <div className="grid grid-cols-2 gap-x-4">
            {ALLERGENS.map((a) => (
              <label key={a} className="flex min-h-12 items-center gap-2 text-sm">
                <input
                  className="size-4 accent-primary"
                  type="checkbox"
                  checked={excluded.includes(a)}
                  onChange={(e) => {
                    setExcluded((x) => (e.target.checked ? [...x, a] : x.filter((v) => v !== a)))
                    setSelection(null)
                  }}
                />
                {ALLERGEN_LABEL[lang][a]}
              </label>
            ))}
          </div>
        </details>
        <p role="status" className="text-sm">
          {menuUi(lang, "results", { n: filtered.total, hidden: filtered.hidden })}
        </p>
        {filtered.incomplete > 0 && (
          <p className="text-xs text-warning">{menuUi(lang, "incomplete", { n: filtered.incomplete })}</p>
        )}
        {excluded.length > 0 && (
          <p className="text-xs text-muted-foreground">{menuUi(lang, "filterNotice")}</p>
        )}
        {(search || category || excluded.length > 0) && (
          <Button
            className="h-12 w-full"
            variant="outline"
            onClick={() => {
              setSearch("")
              setCategory("")
              setExcluded([])
              setSelection(null)
            }}
          >
            {menuUi(lang, "clearFilters")}
          </Button>
        )}
      </section>
      {!filtered.total && <p className="text-sm">{menuUi(lang, "noResults")}</p>}
      <p className="text-xs leading-relaxed text-muted-foreground">{menuUi(lang, "allergenNotice")}</p>
      {selection && canAdd && (
        <div ref={builder} className="scroll-mt-5">
          <LineBuilder
            key={selection.id}
            menu={menu}
            choice={selection}
            lang={lang}
            channel={channel}
            at={at}
            onClose={() => setSelection(null)}
            onAdd={(line) => {
              onAdd(line)
              setSelection(null)
            }}
          />
        </div>
      )}
      {filtered.dailyMenus.length > 0 && (
        <section className="superficie divide-y">
          <h2 className="px-4 py-3 text-lg font-semibold">{menuUi(lang, "dailyMenu")}</h2>
          {filtered.dailyMenus.map((m) => (
            <article key={m.id} className="space-y-2 p-4">
              <div className="flex justify-between gap-4">
                <h3 className="font-medium">{localize(m.name, lang)}</h3>
                <span className="cifra whitespace-nowrap">{euros(m.priceCents, lang)}</span>
              </div>
              <p className="text-sm text-muted-foreground">{localize(m.description, lang)}</p>
              <p className="text-sm">{localize(m.includes, lang)}</p>
              <p className="text-xs text-muted-foreground">
                {m.from} {menuUi(lang, "rangeTo")} {m.to}
              </p>
              {canAdd && m[channel === "table" ? "selfOrder" : "takeaway"] && (
                <Button variant="outline" className="h-12 w-full" onClick={() => setSelection(m)}>
                  {menuUi(lang, "choose")}
                </Button>
              )}
            </article>
          ))}
        </section>
      )}
      {publicMenuSections(filtered).map((s) => (
        <section key={s.category.id} className="superficie divide-y">
          <div className="px-4 py-4">
            <h2 className="text-xl font-semibold">{localize(s.category.name, lang)}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{localize(s.category.description, lang)}</p>
          </div>
          {s.items
            .toSorted((a, b) => Number(!!b.featured) - Number(!!a.featured))
            .map((i) => {
              const price = displayPrice(i)
              return (
                <article key={i.id} className="space-y-3 p-4">
                  {i.photoPath && <Photo path={i.photoPath} alt={localize(i.name, lang)} />}
                  <div className="flex justify-between gap-4">
                    <div>
                      <h3 className="font-medium">{localize(i.name, lang)}</h3>
                      {i.featured && <p className="mt-1 text-xs text-warning">{menuUi(lang, "featured")}</p>}
                    </div>
                    <span className="cifra whitespace-nowrap text-sm">
                      {price.from && `${menuUi(lang, "from")} `}
                      {euros(price.priceCents, lang)}
                    </span>
                  </div>
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {localize(i.description, lang)}
                  </p>
                  {i.variants.length > 0 && (
                    <ul className="space-y-1 text-sm text-soft-foreground">
                      {i.variants.map((v) => (
                        <li key={v.id}>
                          {localize(v.name, lang)} · {euros(v.priceCents, lang)}
                          {v.soldOut && <span className="text-warning"> · {menuUi(lang, "soldOut")}</span>}
                        </li>
                      ))}
                    </ul>
                  )}
                  <ItemOptions
                    item={{ ...i, variants: [], modifierGroups: [] }}
                    language={lang}
                    variantId={null}
                    optionIds={[]}
                    onChange={() => {}}
                  />
                  {i.soldOut ? (
                    <p className="text-sm text-warning">{menuUi(lang, "soldOut")}</p>
                  ) : (
                    canAdd &&
                    i[channel === "table" ? "selfOrder" : "takeaway"] && (
                      <Button variant="outline" className="h-12 w-full" onClick={() => setSelection(i)}>
                        {menuUi(lang, "add")}
                      </Button>
                    )
                  )}
                </article>
              )
            })}
        </section>
      ))}
      <p className="text-center text-xs text-muted-foreground">{menuUi(lang, "vatIncluded")}</p>
    </div>
  )
}
function LineBuilder({
  menu,
  choice,
  lang,
  channel,
  at,
  onClose,
  onAdd,
}: {
  menu: PublicMenu
  choice: PublicMenuItem | PublicDailyMenu
  lang: Language
  channel: "table" | "takeaway"
  at: number
  onClose: () => void
  onAdd: (line: OrderLineInput) => void
}) {
  const isItem = "variants" in choice
  const [variantId, setVariant] = useState<string | null>(null),
    [options, setOptions] = useState<string[]>([])
  const [quantity, setQuantity] = useState(1),
    [notes, setNotes] = useState("")
  const [selectedChoices, setSelectedChoices] = useState<
    Record<string, Extract<OrderLineInput, { kind: "menu" }>["selections"][number]>
  >({})
  const selections = Object.values(selectedChoices)
  const line: OrderLineInput = isItem
    ? { kind: "item", itemId: choice.id, variantId, optionIds: options, quantity, notes, guest: null }
    : { kind: "menu", dailyMenuId: choice.id, quantity, notes, guest: null, selections }
  let total = 0,
    problems: string[] = []
  try {
    const price = reviewOrder(menu, [line], channel, at)
    total = price.totalCents
    problems = price.ok ? [] : price.problems.map((p) => ORDER_PROBLEM_TEXT[lang][p.code])
  } catch {
    problems = [menuUi(lang, "chooseOne")]
  }
  return (
    <section className="superficie space-y-4 border-primary/50 p-4" aria-label={localize(choice.name, lang)}>
      <h2 className="text-lg font-semibold">{localize(choice.name, lang)}</h2>
      {isItem ? (
        <ItemOptions
          item={choice}
          language={lang}
          variantId={variantId}
          optionIds={options}
          onChange={(v, o) => {
            setVariant(v)
            setOptions(o)
          }}
        />
      ) : (
        choice.sections.map((section) => (
          <fieldset className="space-y-3 border-b pb-4" key={section.id}>
            <legend className="mb-2 font-medium">
              {localize(section.name, lang)} ({section.min} {menuUi(lang, "rangeTo")} {section.max})
            </legend>
            {section.choices.map((c) => {
              const item = menu.items.find((i) => i.id === c.itemId)
              if (!item) return null
              const key = `${section.id}:${c.itemId}:${c.variantId ?? ""}`
              const current = selectedChoices[key]
              const update = (patch: Partial<NonNullable<typeof current>>) =>
                setSelectedChoices((x) => ({ ...x, [key]: { ...current, ...patch } }))
              return (
                <div key={key} className="space-y-3">
                  <label className="flex min-h-12 items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      disabled={
                        (item.soldOut || !!item.variants.find((v) => v.id === c.variantId)?.soldOut) &&
                        !current
                      }
                      checked={!!current}
                      onChange={(e) =>
                        setSelectedChoices((x) => {
                          const next = { ...x }
                          if (e.target.checked)
                            next[key] = {
                              sectionId: section.id,
                              itemId: c.itemId,
                              variantId: c.variantId,
                              optionIds: [],
                              notes: "",
                            }
                          else delete next[key]
                          return next
                        })
                      }
                    />
                    {localize(item.name, lang)}
                    {c.variantId &&
                      ` · ${localize(item.variants.find((v) => v.id === c.variantId)?.name ?? item.name, lang)}`}{" "}
                    · +{euros(c.supplementCents, lang)}
                    {(item.soldOut || item.variants.find((v) => v.id === c.variantId)?.soldOut) &&
                      ` · ${menuUi(lang, "soldOut")}`}
                  </label>
                  {current && (
                    <div className="space-y-3 pl-4">
                      <ItemOptions
                        item={item}
                        language={lang}
                        variantId={current.variantId}
                        optionIds={current.optionIds}
                        included
                        fixedVariant={c.variantId !== null}
                        onChange={(variantId, optionIds) => update({ variantId, optionIds })}
                      />
                      <TextareaField
                        label={menuUi(lang, "notes")}
                        maxLength={140}
                        value={current.notes}
                        onChange={(e) => update({ notes: e.target.value })}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </fieldset>
        ))
      )}
      <TextField
        label={menuUi(lang, "quantity")}
        className="h-12"
        type="number"
        min={1}
        max={99}
        value={quantity}
        onChange={(e) => setQuantity(Number(e.target.value))}
      />
      <TextareaField
        label={menuUi(lang, "notes")}
        maxLength={140}
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />
      {problems.length > 0 && (
        <ul className="space-y-1 text-sm text-warning">
          {[...new Set(problems)].map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <Button className="h-12 w-full" disabled={problems.length > 0} onClick={() => onAdd(line)}>
        {menuUi(lang, "add")} · {euros(total, lang)}
      </Button>
      <Button className="h-12 w-full" variant="ghost" onClick={onClose}>
        {lang === "en" ? "Close" : lang === "ca" ? "Tancar" : "Cerrar"}
      </Button>
    </section>
  )
}
