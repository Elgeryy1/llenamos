"use client"

import {
  ALLERGEN_LABEL,
  COURSE_LABEL,
  allergensWith,
  type MenuItem,
  type OrderLineInput,
} from "@llenamos/core"
import { useState } from "react"
import { Desplegable } from "@/components/common/desplegable"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { euros } from "@/lib/comandero/modelo"

export type EleccionPlato = { variantId: string | null; optionIds: string[] }

export function Alergenos({
  item,
  optionIds = [],
}: {
  item: MenuItem
  optionIds?: string[]
}) {
  const names = allergensWith(item, optionIds).map((a) => ALLERGEN_LABEL.es[a])
  return (
    <div className="space-y-1 text-xs">
      <p
        className={names.length ? "text-destructive" : "text-muted-foreground"}
      >
        Alérgenos: {names.join(", ") || "sin alérgenos declarados"}.
      </p>
      {item.traces.length > 0 ? (
        <p className="text-warning">
          Puede contener trazas de{" "}
          {item.traces.map((a) => ALLERGEN_LABEL.es[a]).join(", ")}.
        </p>
      ) : null}
    </div>
  )
}

export function OpcionesPlato({
  item,
  value,
  onChange,
  fixedVariant,
}: {
  item: MenuItem
  value: EleccionPlato
  onChange: (v: EleccionPlato) => void
  fixedVariant?: string | null
}) {
  return (
    <div className="space-y-4">
      {item.variants.length > 0 ? (
        <fieldset>
          <legend className="mb-2 font-medium">Variante obligatoria</legend>
          <div className="flex flex-wrap gap-2">
            {item.variants.map((v) => (
              <Button
                key={v.id}
                type="button"
                variant="outline"
                className="h-12"
                aria-pressed={value.variantId === v.id}
                disabled={fixedVariant != null && fixedVariant !== v.id}
                onClick={() => onChange({ ...value, variantId: v.id })}
              >
                {v.name.es}{" "}
                {fixedVariant === undefined ? euros(v.priceCents) : ""}
              </Button>
            ))}
          </div>
        </fieldset>
      ) : null}
      {item.modifierGroups.map((g) => (
        <fieldset key={g.id}>
          <legend className="mb-2 font-medium">
            {g.name.es}{" "}
            <span className="font-normal text-muted-foreground">
              Elige de {g.min} a {g.max}
            </span>
          </legend>
          <div className="flex flex-wrap gap-2">
            {g.options.map((o) => {
              const checked = value.optionIds.includes(o.id)
              return (
                <Button
                  key={o.id}
                  type="button"
                  variant="outline"
                  className="min-h-12 h-auto whitespace-normal py-2"
                  aria-pressed={checked}
                  disabled={
                    o.soldOut ||
                    (!checked &&
                      g.options.filter((p) => value.optionIds.includes(p.id))
                        .length >= g.max)
                  }
                  onClick={() =>
                    onChange({
                      ...value,
                      optionIds: checked
                        ? value.optionIds.filter((id) => id !== o.id)
                        : [...value.optionIds, o.id],
                    })
                  }
                >
                  {checked ? "✓ " : ""}
                  {o.name.es} · {euros(o.priceCents)}
                  {o.soldOut ? " · Agotado" : ""}
                  {o.allergens.length
                    ? ` · ${o.allergens.map((a) => ALLERGEN_LABEL.es[a]).join(", ")}`
                    : ""}
                </Button>
              )
            })}
          </div>
        </fieldset>
      ))}
      <Alergenos item={item} optionIds={value.optionIds} />
    </div>
  )
}

export function PlatoForm({
  item,
  onAdd, initial,
}: {
  initial?: OrderLineInput
  item: MenuItem & { id: string }
  onAdd: (line: OrderLineInput) => void
}) {
  const original = initial?.kind === "item" ? initial : undefined
  const [choice, setChoice] = useState<EleccionPlato>({
    variantId: original?.variantId ?? null,
    optionIds: original?.optionIds ?? [],
  })
  const [quantity, setQuantity] = useState(original?.quantity ?? 1)
  const [notes, setNotes] = useState(original?.notes ?? "")
  const [guest, setGuest] = useState(original?.guest ? String(original.guest) : "")
  const [course, setCourse] = useState(original?.course ?? item.course)
  const valid =
    (!item.variants.length || choice.variantId !== null) &&
    item.modifierGroups.every((g) => {
      const n = g.options.filter((o) => choice.optionIds.includes(o.id)).length
      return n >= g.min && n <= g.max
    })
  return (
    <div className="space-y-4">
      <OpcionesPlato item={item} value={choice} onChange={setChoice} />
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
        Pase
        <Desplegable
          className="min-h-12"
          value={course}
          onChange={(e) => setCourse(e.target.value as typeof course)}
        >
          {Object.entries(COURSE_LABEL.es).map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </Desplegable>
      </label>
      <label className="block">
        Notas para la cocina
        <Textarea
          value={notes}
          maxLength={140}
          onChange={(e) => setNotes(e.target.value)}
          placeholder="Sin sal, alergia comunicada…"
        />
      </label>
      <Button
        type="button"
        className="h-12 w-full"
        disabled={
          !valid ||
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
            kind: "item",
            itemId: item.id,
            ...choice,
            quantity,
            notes,
            guest: guest === "" ? null : Number(guest),
            course,
          })
        }
      >
        {original ? "Guardar línea" : "Añadir al pedido"}
      </Button>
    </div>
  )
}
