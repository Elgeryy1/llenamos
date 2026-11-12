"use client"
import {
  COURSES,
  COURSE_LABEL,
  DIETARY_LABEL,
  type MenuItemEditable,
  type Station,
  type Variant,
  type ModifierGroup,
} from "@llenamos/core"
import { SelectField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { text } from "@/lib/carta/forms"
import { AllergenFields, MoneyField, NumberField, Toggle, Translation } from "./Fields"

export function ItemEditor({
  value: v,
  onChange,
  categories,
  stations,
}: {
  value: MenuItemEditable
  onChange: (v: MenuItemEditable) => void
  categories: { id: string; name: { es: string } }[]
  stations: (Station & { id: string })[]
}) {
  const set = <K extends keyof MenuItemEditable>(key: K, value: MenuItemEditable[K]) => onChange({ ...v, [key]: value })
  return (
    <div className="space-y-6">
      <Translation label="Nombre del plato" value={v.name} onChange={(x) => set("name", x)} />
      <Translation label="Descripción" maxLength={400} value={v.description} onChange={(x) => set("description", x)} />
      <div className="grid gap-4 sm:grid-cols-3">
        <SelectField label="Categoría" value={v.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
          <option value="">Elige una categoría</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name.es}
            </option>
          ))}
        </SelectField>
        <MoneyField value={v.priceCents} onChange={(x) => set("priceCents", x)} />
        <NumberField
          label="Posición en la carta"
          value={v.sortOrder}
          onChange={(x) => set("sortOrder", x)}
          max={10000}
        />
        <SelectField
          label="Pase"
          value={v.course}
          onChange={(e) => set("course", e.target.value as MenuItemEditable["course"])}
        >
          {COURSES.map((c) => (
            <option key={c} value={c}>
              {COURSE_LABEL.es[c]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Estación"
          value={v.stationId ?? "default"}
          onChange={(e) => set("stationId", e.target.value === "default" ? null : e.target.value)}
        >
          <option value="default">La de los ajustes de sala</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </SelectField>
        <NumberField
          label="Preparación en minutos (0 usa estación)"
          value={v.prepMinutes ?? 0}
          onChange={(x) => set("prepMinutes", x === 0 ? null : x)}
        />
        <SelectField
          label="IVA incluido"
          value={v.taxRate}
          onChange={(e) => set("taxRate", Number(e.target.value) as MenuItemEditable["taxRate"])}
        >
          {[0, 4, 10, 21].map((t) => (
            <option key={t} value={t}>
              {t} %
            </option>
          ))}
        </SelectField>
      </div>
      <Variants value={v.variants} onChange={(x) => set("variants", x)} />
      <Extras value={v.modifierGroups} onChange={(x) => set("modifierGroups", x)} />
      <AllergenFields label="Contiene estos alérgenos" value={v.allergens} onChange={(x) => set("allergens", x)} />
      <AllergenFields label="Puede contener trazas" value={v.traces} onChange={(x) => set("traces", x)} />
      <Toggle
        label="Información de alérgenos y trazas revisada, incluidos los extras"
        checked={!!v.allergensReviewed}
        onChange={(x) => set("allergensReviewed", x)}
      />
      <Toggle label="Sugerencia de la casa" checked={!!v.featured} onChange={(x) => set("featured", x)} />
      <div className="flex flex-wrap gap-x-6">
        {(["vegetarian", "vegan"] as const).map((t) => (
          <Toggle
            key={t}
            label={DIETARY_LABEL.es[t]}
            checked={v.dietary.includes(t)}
            onChange={(x) => set("dietary", x ? [...v.dietary, t] : v.dietary.filter((d) => d !== t))}
          />
        ))}
        <Toggle label="Visible en la carta" checked={v.active} onChange={(x) => set("active", x)} />
        <Toggle label="Pedir desde la mesa" checked={v.selfOrder} onChange={(x) => set("selfOrder", x)} />
        <Toggle label="Pedir para llevar" checked={v.takeaway} onChange={(x) => set("takeaway", x)} />
      </div>
    </div>
  )
}
function Variants({ value, onChange }: { value: Variant[]; onChange: (v: Variant[]) => void }) {
  const update = (i: number, patch: Partial<Variant>) =>
    onChange(value.map((v, n) => (n === i ? { ...v, ...patch } : v)))
  return (
    <section className="space-y-4">
      <h3 className="font-medium">Variantes</h3>
      <p className="text-sm text-muted-foreground">
        Si añades variantes, el cliente debe elegir una. Su precio sustituye al precio base.
      </p>
      {value.map((v, i) => (
        <div key={v.id} className="space-y-3 border-b pb-4">
          <Translation
            label={`Variante ${i + 1}`}
            maxLength={40}
            value={v.name}
            onChange={(name) => update(i, { name })}
          />
          <MoneyField value={v.priceCents} onChange={(priceCents) => update(i, { priceCents })} />
          <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, n) => n !== i))}>
            Quitar variante {i + 1}
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={value.length >= 10}
        onClick={() => onChange([...value, { id: crypto.randomUUID().slice(0, 8), name: text(), priceCents: 0 }])}
      >
        Añadir variante
      </Button>
    </section>
  )
}
function Extras({ value, onChange }: { value: ModifierGroup[]; onChange: (v: ModifierGroup[]) => void }) {
  const update = (i: number, patch: Partial<ModifierGroup>) =>
    onChange(value.map((v, n) => (n === i ? { ...v, ...patch } : v)))
  return (
    <section className="space-y-4">
      <h3 className="font-medium">Extras y opciones</h3>
      {value.map((g, i) => (
        <fieldset key={g.id} className="space-y-4 border-b pb-5">
          <Translation
            label={`Grupo ${i + 1}`}
            maxLength={60}
            value={g.name}
            onChange={(name) => update(i, { name })}
          />
          <div className="grid grid-cols-2 gap-4">
            <NumberField label="Mínimo de opciones" value={g.min} max={20} onChange={(min) => update(i, { min })} />
            <NumberField
              label="Máximo de opciones"
              min={1}
              max={20}
              value={g.max}
              onChange={(max) => update(i, { max })}
            />
          </div>
          {g.options.map((o, j) => (
            <div key={o.id} className="space-y-3 rounded-lg bg-surface-sunken p-4">
              <Translation
                label={`Opción ${j + 1}`}
                maxLength={60}
                value={o.name}
                onChange={(name) => update(i, { options: g.options.map((x, n) => (n === j ? { ...x, name } : x)) })}
              />
              <MoneyField
                label="Precio adicional (€)"
                value={o.priceCents}
                onChange={(priceCents) =>
                  update(i, { options: g.options.map((x, n) => (n === j ? { ...x, priceCents } : x)) })
                }
              />
              <AllergenFields
                label="Alérgenos de la opción"
                value={o.allergens}
                onChange={(allergens) =>
                  update(i, { options: g.options.map((x, n) => (n === j ? { ...x, allergens } : x)) })
                }
              />
              <Toggle
                label="Opción agotada"
                checked={o.soldOut}
                onChange={(soldOut) =>
                  update(i, { options: g.options.map((x, n) => (n === j ? { ...x, soldOut } : x)) })
                }
              />
              <Button
                type="button"
                variant="ghost"
                onClick={() => update(i, { options: g.options.filter((_, n) => n !== j) })}
              >
                Quitar opción {j + 1}
              </Button>
            </div>
          ))}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                update(i, {
                  options: [
                    ...g.options,
                    {
                      id: crypto.randomUUID().slice(0, 8),
                      name: text(),
                      priceCents: 0,
                      allergens: [],
                      soldOut: false,
                    },
                  ],
                })
              }
            >
              Añadir opción
            </Button>
            <Button type="button" variant="ghost" onClick={() => onChange(value.filter((_, n) => n !== i))}>
              Quitar grupo
            </Button>
          </div>
        </fieldset>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={value.length >= 10}
        onClick={() =>
          onChange([
            ...value,
            { id: crypto.randomUUID().slice(0, 8), name: text(), min: 0, max: 1, options: [] },
          ])
        }
      >
        Añadir grupo de extras
      </Button>
    </section>
  )
}
