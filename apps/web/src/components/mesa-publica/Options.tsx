"use client"
import {
  localize,
  menuUi,
  ALLERGEN_LABEL,
  allergensWith,
  type Language,
  type PublicMenuItem,
} from "@llenamos/core"
import { SelectField } from "@/components/common/form-fields"
import { euros } from "@/lib/carta/forms"
import { Toggle } from "@/components/carta/Fields"
export function ItemOptions({
  item,
  language: lang,
  variantId,
  optionIds,
  onChange,
  fixedVariant = false,
  included = false,
}: {
  item: PublicMenuItem
  language: Language
  variantId: string | null
  optionIds: string[]
  onChange: (variantId: string | null, optionIds: string[]) => void
  fixedVariant?: boolean
  included?: boolean
}) {
  return (
    <div className="space-y-3">
      {item.variants.length > 0 && (
        <SelectField
          className="h-12"
          label={menuUi(lang, "chooseOne")}
          value={variantId ?? ""}
          disabled={fixedVariant}
          onChange={(e) => onChange(e.target.value, optionIds)}
        >
          <option value="">{menuUi(lang, "choose")}</option>
          {item.variants.map((v) => (
            <option key={v.id} value={v.id} disabled={v.soldOut}>
              {localize(v.name, lang)}
              {v.soldOut ? ` · ${menuUi(lang, "soldOut")}` : ""}
              {included ? "" : ` · ${euros(v.priceCents, lang)}`}
            </option>
          ))}
        </SelectField>
      )}
      {item.modifierGroups.map((g) => (
        <fieldset key={g.id}>
          <legend className="text-sm font-medium">
            {localize(g.name, lang)}{" "}
            <span className="text-muted-foreground">
              ({g.min} {menuUi(lang, "rangeTo")} {g.max})
            </span>
          </legend>
          {g.options.map((o) => (
            <Toggle
              key={o.id}
              disabled={o.soldOut && !optionIds.includes(o.id)}
              label={`${localize(o.name, lang)} · +${euros(o.priceCents, lang)}${o.soldOut ? ` · ${menuUi(lang, "soldOut")}` : ""}`}
              checked={optionIds.includes(o.id)}
              onChange={(checked) => {
                if (!o.soldOut || !checked)
                  onChange(variantId, checked ? [...optionIds, o.id] : optionIds.filter((id) => id !== o.id))
              }}
            />
          ))}
        </fieldset>
      ))}
      <p className="text-xs leading-relaxed text-muted-foreground">
        {menuUi(lang, "allergens")}:{" "}
        {allergensWith(item, optionIds)
          .map((a) => ALLERGEN_LABEL[lang][a])
          .join(", ") || menuUi(lang, "noAllergens")}
        {item.traces.length > 0 && (
          <>
            . {menuUi(lang, "traces")}: {item.traces.map((a) => ALLERGEN_LABEL[lang][a]).join(", ")}
          </>
        )}
      </p>
    </div>
  )
}
