"use client"

import { useState } from "react"
import type { DailyMenu, OrderLineInput } from "@llenamos/core"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { Carta } from "@/lib/comandero/datos"
import { euros } from "@/lib/comandero/modelo"
import { OpcionesPlato, type EleccionPlato } from "./OpcionesPlato"

type Selection = Extract<OrderLineInput, { kind: "menu" }>["selections"][number]

export function MenuForm({
  menu,
  carta,
  onAdd,
}: {
  menu: DailyMenu & { id: string }
  carta: Carta
  onAdd: (line: OrderLineInput) => void
}) {
  const [selections, setSelections] = useState<Selection[]>([])
  const [quantity, setQuantity] = useState(1)
  const [notes, setNotes] = useState("")
  const [guest, setGuest] = useState("")
  const valid =
    menu.sections.every((s) => {
      const n = selections.filter((c) => c.sectionId === s.id).length
      return n >= s.min && n <= s.max
    }) &&
    selections.every((s) => {
      const item = carta.items.find((i) => i.id === s.itemId)
      return (
        item &&
        item.active &&
        !item.soldOut &&
        (!item.variants.length || s.variantId !== null) &&
        item.modifierGroups.every((g) => {
          const n = g.options.filter(
            (o) => s.optionIds.includes(o.id) && !o.soldOut,
          ).length
          return n >= g.min && n <= g.max
        })
      )
    })
  return (
    <div className="space-y-5">
      <p className="text-muted-foreground">
        {menu.includes.es} · {euros(menu.priceCents)} por menú, más suplementos
        y extras.
      </p>
      {menu.sections.map((section) => (
        <fieldset key={section.id} className="space-y-3 border-t pt-3">
          <legend className="text-base font-semibold">
            {section.name.es} · de {section.min} a {section.max}
          </legend>
          {section.choices.map((c, index) => {
            const item = carta.items.find((i) => i.id === c.itemId)
            if (!item) return <p key={index}>Plato no disponible</p>
            const selected = selections.find(
              (s) =>
                s.sectionId === section.id &&
                s.itemId === c.itemId &&
                (c.variantId === null || s.variantId === c.variantId),
            )
            const update = (value: EleccionPlato) =>
              setSelections((all) =>
                all.map((s) => (s === selected ? { ...s, ...value } : s)),
              )
            return (
              <div key={index} className="space-y-3">
                <Button
                  type="button"
                  variant="outline"
                  className="min-h-12 h-auto w-full justify-start whitespace-normal py-2 text-left"
                  aria-pressed={!!selected}
                  disabled={
                    item.soldOut ||
                    !item.active ||
                    (!selected &&
                      selections.filter((s) => s.sectionId === section.id)
                        .length >= section.max)
                  }
                  onClick={() =>
                    setSelections(
                      selected
                        ? selections.filter((s) => s !== selected)
                        : [
                            ...selections,
                            {
                              sectionId: section.id,
                              itemId: item.id,
                              variantId: c.variantId,
                              optionIds: [],
                              notes: "",
                            },
                          ],
                    )
                  }
                >
                  {selected ? "✓ " : ""}
                  {item.name.es}
                  {c.supplementCents
                    ? ` · suplemento ${euros(c.supplementCents)}`
                    : ""}
                  {c.variantId
                    ? ` · ${item.variants.find((v) => v.id === c.variantId)?.name.es ?? c.variantId}`
                    : ""}
                  {item.soldOut ? " · Agotado" : ""}
                </Button>
                {selected ? (
                  <div className="space-y-3 border-l-2 pl-3">
                    <OpcionesPlato
                      item={item}
                      value={selected}
                      fixedVariant={c.variantId}
                      onChange={update}
                    />
                    <label className="block">
                      Notas de {item.name.es}
                      <Textarea
                        maxLength={140}
                        value={selected.notes}
                        onChange={(e) =>
                          setSelections((all) =>
                            all.map((s) =>
                              s === selected
                                ? { ...s, notes: e.target.value }
                                : s,
                            ),
                          )
                        }
                      />
                    </label>
                  </div>
                ) : null}
              </div>
            )
          })}
        </fieldset>
      ))}
      <div className="grid grid-cols-2 gap-3">
        <label>
          Cantidad
          <Input
            className="h-12"
            type="number"
            min={1}
            max={99}
            value={quantity}
            onChange={(e) => setQuantity(Number(e.target.value))}
          />
        </label>
        <label>
          Comensal opcional
          <Input
            className="h-12"
            type="number"
            min={1}
            max={50}
            value={guest}
            onChange={(e) => setGuest(e.target.value)}
          />
        </label>
      </div>
      <label className="block">
        Notas del menú
        <Textarea
          maxLength={140}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </label>
      <Button
        type="button"
        className="h-12 w-full"
        disabled={
          !valid ||
          !selections.length ||
          !Number.isInteger(quantity) ||
          quantity < 1 ||
          quantity > 99 ||
          (guest !== "" &&
            (!Number.isInteger(Number(guest)) ||
              Number(guest) < 1 ||
              Number(guest) > 50))
        }
        onClick={() =>
          onAdd({
            kind: "menu",
            dailyMenuId: menu.id,
            selections,
            quantity,
            notes,
            guest: guest ? Number(guest) : null,
          })
        }
      >
        Añadir menú
      </Button>
    </div>
  )
}
