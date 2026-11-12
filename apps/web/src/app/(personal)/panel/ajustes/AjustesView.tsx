"use client"

import { useState, type FormEvent } from "react"
import { PageHeading } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { PlanModulos } from "@/components/config/PlanModulos"
import { ProveedoresRestaurante } from "@/components/proveedores/ProveedoresRestaurante"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import type { RestaurantDoc } from "@/lib/data/parse"
import { LOCALE_LABEL } from "@/lib/demo"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import { fieldErrors } from "@/lib/forms"
import { guardarAjustes } from "@/lib/panel/guardar-ajustes"
import { ajustesFrom, AjustesSchema, changedFields, isLightColor, normalizeHex, type Ajustes } from "@/lib/panel/ajustes"
import { initials } from "@/lib/panel/equipo"

const FIELDS = ["name", "brandColor", "locale"] as const

export function AjustesView() {
  const { restaurant } = usePanel()
  return (
    <RequirePermission permission="ajustes.gestionar" what="los ajustes">
      {/* Al cambiar de restaurante, el formulario empieza de cero. */}
      <AjustesForm key={restaurant.id} />
    </RequirePermission>
  )
}

function AjustesForm() {
  const { restaurant, user } = usePanel()
  const saved = ajustesFrom(restaurant)

  // El borrador empieza vacío: mientras no se toca un campo, se enseña lo guardado
  // (y si otra persona lo cambia, se ve al momento).
  const [draft, setDraft] = useState<Partial<Ajustes>>({})
  const [colorText, setColorText] = useState<string | null>(null)
  const [errors, setErrors] = useState<Partial<Record<(typeof FIELDS)[number], string>>>({})
  const [error, setError] = useState<ErrorInfo | null>(null)
  const [pending, setPending] = useState(false)
  const [savedAt, setSavedAt] = useState<number | null>(null)

  const values: Ajustes = { ...saved, ...draft }
  const changes = changedFields(saved, values)
  const dirty = Object.keys(changes).length > 0 || (colorText !== null && normalizeHex(colorText) !== values.brandColor)

  function edit(patch: Partial<Ajustes>) {
    setDraft((d) => ({ ...d, ...patch }))
    setSavedAt(null)
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const candidate = { ...values, brandColor: colorText !== null ? (normalizeHex(colorText) ?? colorText) : values.brandColor }
    const parsed = AjustesSchema.safeParse(candidate)
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, FIELDS))
      return
    }
    setErrors({})
    const toWrite = changedFields(saved, parsed.data)
    if (Object.keys(toWrite).length === 0) {
      setDraft({})
      setColorText(null)
      return
    }
    setPending(true)
    try {
      await guardarAjustes(restaurant.id, user.uid, toWrite)
      setDraft({})
      setColorText(null)
      setSavedAt(Date.now())
    } catch (e) {
      setError(describeError(e))
    } finally {
      setPending(false)
    }
  }

  function discard() {
    setDraft({})
    setColorText(null)
    setErrors({})
    setError(null)
  }

  return (
    <>
      <PageHeading eyebrow={`${restaurant.name} · Ajustes`} title="La identidad de tu restaurante" description="El nombre, el color y el idioma que ven tu equipo y tus clientes." />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Card className="superficie rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
          <CardHeader>
            <CardTitle className="font-semibold">Restaurante</CardTitle>
            <CardDescription>Nombre, color de marca e idioma por defecto.</CardDescription>
          </CardHeader>
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            <CardContent>
            <FieldGroup>
            <TextField
              label="Nombre"
              name="name"
              value={values.name}
              onChange={(e) => edit({ name: e.target.value })}
              error={errors.name}
              disabled={pending}
              autoComplete="organization"
            />

            <TextField
                label="Color de marca"
                name="brandColor"
                className="cifra pointer-coarse:pr-14"
                value={colorText ?? values.brandColor}
                onChange={(e) => {
                  setColorText(e.target.value)
                  const hex = normalizeHex(e.target.value)
                  if (hex) edit({ brandColor: hex })
                }}
                onBlur={() => {
                  const hex = colorText !== null ? normalizeHex(colorText) : null
                  if (hex) setColorText(null)
                }}
                error={errors.brandColor}
                hint="En hexadecimal, como #f0a35e. Se usa en la página de reservas."
                disabled={pending}
                spellCheck={false}
                trailing={
                  <input
                    type="color"
                    aria-label="Elegir el color"
                    value={values.brandColor}
                    disabled={pending}
                    onChange={(e) => {
                      setColorText(null)
                      edit({ brandColor: e.target.value.toLowerCase() })
                    }}
                    className="size-7 cursor-pointer rounded-md pointer-coarse:size-11 border bg-transparent p-0.5 disabled:cursor-not-allowed"
                  />
                }
              />

            <SelectField
              label="Idioma"
              name="locale"
              value={values.locale}
              onChange={(e) => edit({ locale: e.target.value as Ajustes["locale"] })}
              error={errors.locale}
              hint="Idioma por defecto de los textos para tus clientes."
              disabled={pending}
            >
              {(Object.keys(LOCALE_LABEL) as Array<keyof typeof LOCALE_LABEL>).map((l) => (
                <option key={l} value={l}>
                  {LOCALE_LABEL[l]}
                </option>
              ))}
            </SelectField>

            {error ? (
              <Notice tone="error" title="No se han podido guardar los cambios" detail={error.code}>
                {error.message}
              </Notice>
            ) : null}
            {savedAt && !dirty ? <Notice tone="success">Cambios guardados.</Notice> : null}

            </FieldGroup>
            </CardContent>
            <CardFooter className="flex-wrap gap-2 bg-surface-sunken/50">
              <Button type="submit" size="lg" disabled={!dirty || pending} aria-busy={pending || undefined}>
                {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
                {pending ? "Guardando…" : "Guardar cambios"}
              </Button>
              {dirty && !pending ? (
                <Button type="button" variant="ghost" size="lg" onClick={discard}>
                  Descartar
                </Button>
              ) : null}
            </CardFooter>
          </form>
        </Card>

        <Preview restaurant={restaurant} values={values} />
      </div>
      <PlanModulos restaurant={restaurant} className="superficie mt-6 rounded-[12px] shadow-soft ring-0 sm:rounded-[14px] lg:max-w-[calc(100%-19.5rem)]" />
      <div className="mt-6 lg:max-w-[calc(100%-19.5rem)]">
        <ProveedoresRestaurante />
      </div>
    </>
  )
}

/** Cómo queda la marca con los valores que se están editando. */
function Preview({ restaurant, values }: { restaurant: RestaurantDoc; values: Ajustes }) {
  const name = values.name.trim() || restaurant.name
  const light = isLightColor(values.brandColor)
  return (
    <Card className="superficie self-start rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
      <CardHeader>
        <CardTitle className="font-semibold">Vista previa</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden
            className="flex size-10 items-center justify-center rounded-lg text-sm font-semibold transition-colors duration-300"
            style={{ background: values.brandColor, color: light ? "#131209" : "#f4f1ea" }}
          >
            {initials(name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{name}</p>
            <p className="text-xs text-muted-foreground">{LOCALE_LABEL[values.locale]}</p>
          </div>
        </div>
        <span
          className="inline-flex h-12 items-center justify-center rounded-xl text-base font-medium transition-colors duration-300"
          style={{ background: values.brandColor, color: light ? "#131209" : "#f4f1ea" }}
        >
          Reservar mesa
        </span>
        <p className="text-xs text-muted-foreground">Así se ve tu marca en la página de reservas.</p>
      </CardContent>
    </Card>
  )
}
