"use client"
import { COURSES, COURSE_LABEL, type DailyMenuEditable, type MenuItem } from "@llenamos/core"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { text } from "@/lib/carta/forms"
import { MoneyField, NumberField, Toggle, Translation } from "./Fields"
export function DailyMenuEditor({
  value: v,
  onChange,
  items,
}: {
  value: DailyMenuEditable
  onChange: (v: DailyMenuEditable) => void
  items: (MenuItem & { id: string })[]
}) {
  const set = <K extends keyof DailyMenuEditable>(k: K, x: DailyMenuEditable[K]) => onChange({ ...v, [k]: x })
  const section = (i: number, patch: Partial<DailyMenuEditable["sections"][number]>) =>
    set(
      "sections",
      v.sections.map((s, n) => (n === i ? { ...s, ...patch } : s)),
    )
  return (
    <div className="space-y-6">
      <Translation label="Nombre del menú" value={v.name} onChange={(x) => set("name", x)} />
      <Translation label="Descripción" maxLength={400} value={v.description} onChange={(x) => set("description", x)} />
      <Translation label="Qué incluye" maxLength={200} value={v.includes} onChange={(x) => set("includes", x)} />
      <MoneyField value={v.priceCents} onChange={(x) => set("priceCents", x)} />
      <div className="flex flex-wrap gap-4">
        {(["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const).map((d, i) => (
          <Toggle
            key={d}
            label={["Lunes", "Martes", "Miércoles", "Jueves", "Viernes", "Sábado", "Domingo"][i]}
            checked={v.days.includes(d)}
            onChange={(x) => set("days", x ? [...v.days, d] : v.days.filter((day) => day !== d))}
          />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <TextField label="Desde" type="time" value={v.from} onChange={(e) => set("from", e.target.value)} />
        <TextField label="Hasta" type="time" value={v.to} onChange={(e) => set("to", e.target.value)} />
        <NumberField label="Posición" value={v.sortOrder} max={10000} onChange={(x) => set("sortOrder", x)} />
        <SelectField
          label="IVA incluido"
          value={v.taxRate}
          onChange={(e) => set("taxRate", Number(e.target.value) as DailyMenuEditable["taxRate"])}
        >
          {[0, 4, 10, 21].map((t) => (
            <option key={t} value={t}>
              {t} %
            </option>
          ))}
        </SelectField>
      </div>
      {v.sections.map((s, i) => (
        <section key={s.id} className="space-y-4 border-b pb-6">
          <Translation
            label={`Sección ${i + 1}`}
            maxLength={40}
            value={s.name}
            onChange={(name) => section(i, { name })}
          />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Pase"
              value={s.course}
              onChange={(e) => section(i, { course: e.target.value as typeof s.course })}
            >
              {COURSES.map((c) => (
                <option key={c} value={c}>
                  {COURSE_LABEL.es[c]}
                </option>
              ))}
            </SelectField>
            <NumberField label="Platos mínimos" value={s.min} max={5} onChange={(min) => section(i, { min })} />
            <NumberField label="Platos máximos" min={1} value={s.max} max={5} onChange={(max) => section(i, { max })} />
          </div>
          {s.choices.map((c, j) => {
            const item = items.find((x) => x.id === c.itemId)
            const choice = (patch: Partial<typeof c>) =>
              section(i, { choices: s.choices.map((x, n) => (n === j ? { ...x, ...patch } : x)) })
            return (
              <div key={j} className="grid gap-3 rounded-lg bg-surface-sunken p-3 sm:grid-cols-3">
                <SelectField
                  label="Plato incluido"
                  value={c.itemId}
                  onChange={(e) => choice({ itemId: e.target.value, variantId: null })}
                >
                  <option value="">Elige plato</option>
                  {items.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name.es}
                    </option>
                  ))}
                </SelectField>
                <SelectField
                  label="Variante incluida"
                  value={c.variantId ?? "choose"}
                  onChange={(e) => choice({ variantId: e.target.value === "choose" ? null : e.target.value })}
                >
                  <option value="choose">La elige el cliente</option>
                  {item?.variants.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name.es}
                    </option>
                  ))}
                </SelectField>
                <MoneyField
                  label="Suplemento (€)"
                  value={c.supplementCents}
                  onChange={(supplementCents) => choice({ supplementCents })}
                />
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => section(i, { choices: s.choices.filter((_, n) => n !== j) })}
                >
                  Quitar plato
                </Button>
              </div>
            )
          })}
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                section(i, { choices: [...s.choices, { itemId: "", variantId: null, supplementCents: 0 }] })
              }
            >
              Añadir plato a la sección
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() =>
                set(
                  "sections",
                  v.sections.filter((_, n) => n !== i),
                )
              }
            >
              Quitar sección
            </Button>
          </div>
        </section>
      ))}
      <Button
        type="button"
        variant="outline"
        disabled={v.sections.length >= 8}
        onClick={() =>
          set("sections", [
            ...v.sections,
            { id: crypto.randomUUID().slice(0, 8), name: text(), course: "first", min: 1, max: 1, choices: [] },
          ])
        }
      >
        Añadir sección
      </Button>
      <div className="flex flex-wrap gap-5">
        <Toggle label="Visible" checked={v.active} onChange={(x) => set("active", x)} />
        <Toggle label="Pedir desde la mesa" checked={v.selfOrder} onChange={(x) => set("selfOrder", x)} />
        <Toggle label="Pedir para llevar" checked={v.takeaway} onChange={(x) => set("takeaway", x)} />
      </div>
    </div>
  )
}
