"use client"

import { horaLocal, PASOS_PERMITIDOS, type Exception, type Weekday } from "@llenamos/core"
import { CopyIcon, PlusIcon, StorefrontIcon, XIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { DateInput } from "@/components/common/date-picker"
import { EmptyState } from "@/components/common/empty-state"
import { SelectField, TextField } from "@/components/common/form-fields"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { SegmentedControl } from "@/components/common/segmented-control"
import { SettingsSection as Section } from "@/components/common/settings-section"
import { NumberField, SwitchRow, TimeInput } from "@/components/horarios/campos"
import { ShiftsEditor } from "@/components/horarios/ShiftsEditor"
import { SaveBar } from "@/components/config/SaveBar"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading as PageHeader } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { useCloseOnHide } from "@/lib/open-state"
import { toast } from "sonner"
import { Skeleton } from "@/components/ui/skeleton"
import { useReservationSettings, type SettingsDoc } from "@/lib/config/hooks"
import { llamarCore } from "@/lib/data/callables"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import * as F from "@/lib/horarios/form"
import { useNow } from "@/lib/use-now"

export function HorariosView() {
  return (
    <RequirePermission permission="reservas.configurar" what="los horarios y las reservas">
      <RequireModule module="reservations">
        <Horarios />
      </RequireModule>
    </RequirePermission>
  )
}

function Horarios() {
  const { restaurant, location } = usePanel()
  const doc = useReservationSettings(restaurant.id, location?.id ?? null)

  if (!location) {
    return (
      <>
        <PageHeader title="Horarios y reservas" />
        <EmptyState icon={<StorefrontIcon />} title="Este restaurante aún no tiene locales" description="Los horarios se configuran para cada local." />
      </>
    )
  }
  if (doc.status === "loading") {
    return (
      <>
        <PageHeader title="Horarios y reservas" eyebrow={location.name} />
        <LoadingBlock label="Cargando la configuración…" className="flex flex-col gap-4">
          <Skeleton className="h-48 w-full rounded-xl" />
          <Skeleton className="h-32 w-full rounded-xl" />
        </LoadingBlock>
      </>
    )
  }
  if (doc.status === "error") {
    return (
      <>
        <PageHeader title="Horarios y reservas" eyebrow={location.name} />
        <LiveError title="No se ha podido cargar la configuración de reservas" error={doc.error} />
      </>
    )
  }
  return <Formulario key={location.id} locationId={location.id} locationName={location.name} doc={doc.data} />
}

function Formulario({ locationId, locationName, doc }: { locationId: string; locationName: string; doc: SettingsDoc }) {
  const { restaurant } = usePanel()
  const [draft, setDraft] = useState<F.Settings | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const now = useNow()

  const s = draft ?? doc.settings
  const dirty = draft !== null && !F.sameSettings(draft, doc.settings)
  const validation = useMemo(() => F.validateSettings(s), [s])
  const errors = validation.errors
  const errorCount = Object.keys(errors).length

  function edit(fn: (s: F.Settings) => F.Settings) {
    setError(null)
    setDraft((d) => fn(d ?? doc.settings))
  }
  const set = <K extends keyof F.Settings>(key: K, value: F.Settings[K]) => edit((x) => ({ ...x, [key]: value }))

  async function save() {
    if (!validation.data) return
    setPending(true)
    setError(null)
    try {
      await llamarCore("guardarConfiguracionReservas", F.saveInput(restaurant.id, locationId, validation.data))
      setDraft(null)
      toast.success("Configuración guardada. Ya se aplica a las reservas nuevas.")
    } catch (e) {
      setError(describeError(e))
    } finally {
      setPending(false)
    }
  }

  const today = horaLocal(now.getTime(), s.timezone).fecha

  return (
    <>
      <PageHeader
        eyebrow={locationName}
        title={F.weekSummary(s)}
        description="Cuándo se puede reservar, cuánto dura cada mesa y qué políticas ve el cliente al reservar por la web."
      />

      {!doc.saved ? (
        <Notice tone="info" title="Aún no has guardado la configuración de este local" className="mb-4">
          Estos son los valores de partida. Mientras no los guardes, las reservas por la web siguen apagadas.
        </Notice>
      ) : null}
      {error ? (
        <Notice tone="error" title="No se ha guardado" detail={error.code} className="mb-4">
          {error.message}
        </Notice>
      ) : null}
      {dirty && errorCount > 0 ? (
        <Notice tone="warning" title="Revisa estos datos antes de guardar" className="mb-4">
          <ul className="list-disc pl-4">
            {Object.entries(errors)
              .slice(0, 6)
              .map(([k, v]) => (
                <li key={k}>
                  {F.sectionOf(k)}: {v}
                </li>
              ))}
          </ul>
        </Notice>
      ) : null}

      <nav aria-label="Secciones de horarios" className="mb-6 flex flex-wrap gap-1 rounded-xl border bg-surface-sunken/60 p-1">
        {[["semana", "Semana"], ["vista", "Horas disponibles"], ["especiales", "Días especiales"], ["duracion", "Capacidad"], ["web", "Reservas web"], ["senal", "Políticas"]].map(([id, label]) => (
          <a key={id} href={`#${id}`} className="flex min-h-11 items-center rounded-lg px-3 text-sm text-muted-foreground transition-colors hover:bg-surface-raised hover:text-foreground">{label}</a>
        ))}
      </nav>
      <div className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
        <span className="flex items-center gap-2"><span aria-hidden className={`size-2 rounded-full ${s.publicBooking ? "bg-success" : "bg-ash"}`} />{s.publicBooking ? "Reservas web abiertas" : "Reservas web cerradas"}</span>
        <span className="cifra">{s.timezone}</span>
        <span>Los cambios se aplican al guardar</span>
      </div>
      <div className="flex flex-col gap-6">
        <Semana s={s} errors={errors} edit={edit} />
        <Vista s={s} today={today} />
        <DiasEspeciales s={s} errors={errors} edit={edit} today={today} />
        <Cierres s={s} errors={errors} edit={edit} today={today} />

        <Section id="duracion" title="Duración y capacidad" description="Cuánto tiempo se guarda una mesa según el tamaño del grupo y cuánta gente cabe a la vez.">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Duración por tamaño de grupo</span>
            <ul className="flex flex-col gap-2">
              {s.duration.tiers.map((t, i) => (
                <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">Hasta</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    aria-label={`Comensales del tramo ${i + 1}`}
                    className="cifra h-9 w-20"
                    value={F.intToInput(t.upToGuests)}
                    aria-invalid={errors[`duration.tiers.${i}.upToGuests`] || errors[`duration.tiers.${i}`] ? true : undefined}
                    onChange={(e) => edit((x) => F.updateTier(x, i, { upToGuests: F.intFromInput(e.target.value) }))}
                  />
                  <span className="text-muted-foreground">personas,</span>
                  <Input
                    type="number"
                    inputMode="numeric"
                    min={15}
                    step={15}
                    aria-label={`Minutos del tramo ${i + 1}`}
                    className="cifra h-9 w-20"
                    value={F.intToInput(t.minutes)}
                    aria-invalid={errors[`duration.tiers.${i}.minutes`] ? true : undefined}
                    onChange={(e) => edit((x) => F.updateTier(x, i, { minutes: F.intFromInput(e.target.value) }))}
                  />
                  <span className="text-muted-foreground">min</span>
                  <span className="cifra text-xs text-muted-foreground">{F.formatMinutes(t.minutes)}</span>
                  <Button variant="ghost" size="icon" className="pointer-coarse:min-w-11" aria-label={`Quitar el tramo ${i + 1}`} onClick={() => edit((x) => F.removeTier(x, i))}>
                    <XIcon aria-hidden />
                  </Button>
                  {F.errorsUnder(errors, `duration.tiers.${i}`).length > 0 ? (
                    <span role="alert" className="w-full text-xs text-destructive">
                      {F.errorsUnder(errors, `duration.tiers.${i}`).join(" ")}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            <Button variant="ghost" size="sm" className="self-start text-muted-foreground" onClick={() => edit(F.addTier)} disabled={s.duration.tiers.length >= 20}>
              <PlusIcon aria-hidden />
              Añadir tramo
            </Button>
          </div>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            <NumberField
              label="Grupos más grandes"
              unit="min"
              value={s.duration.defaultMinutes}
              error={errors["duration.defaultMinutes"]}
              hint="Para los grupos que no entran en ningún tramo."
              onChange={(t) => edit((x) => ({ ...x, duration: { ...x.duration, defaultMinutes: F.intFromInput(t) } }))}
            />
            <NumberField
              label="Margen entre reservas"
              unit="min"
              value={s.bufferMinutes}
              error={errors.bufferMinutes}
              hint="Tiempo para recoger y montar la mesa."
              onChange={(t) => set("bufferMinutes", F.intFromInput(t))}
            />
            <SelectField
              label="Intervalo entre horas"
              value={String(s.stepMinutes)}
              error={errors.stepMinutes}
              hint="Cada cuánto se ofrece una hora: 13:00, 13:15…"
              onChange={(e) => set("stepMinutes", Number(e.target.value))}
            >
              {PASOS_PERMITIDOS.map((p) => (
                <option key={p} value={p}>
                  {p} minutos
                </option>
              ))}
            </SelectField>
            <NumberField
              label="Llegadas por franja"
              unit="personas"
              optional
              placeholder="Sin límite"
              value={s.maxGuestsPerSlot}
              error={errors.maxGuestsPerSlot}
              hint="Comensales que pueden llegar a la vez. Vacío, sin límite."
              onChange={(t) => set("maxGuestsPerSlot", F.optionalIntFromInput(t))}
            />
            <NumberField
              label="Mesas que se pueden juntar"
              value={s.maxJoinedTables}
              min={1}
              max={6}
              error={errors.maxJoinedTables}
              hint="1 para no juntar mesas nunca."
              onChange={(t) => set("maxJoinedTables", F.intFromInput(t))}
            />
            <NumberField
              label="Plazas que se pierden al juntar"
              value={s.seatsLostPerJoin}
              min={0}
              max={4}
              error={errors.seatsLostPerJoin}
              hint="Por cada unión de dos mesas."
              onChange={(t) => set("seatsLostPerJoin", F.intFromInput(t))}
            />
          </div>
        </Section>

        <Section id="web" title="Reservas por la web" description="Lo que puede reservar un cliente él solo desde tu página o el widget. El equipo puede saltarse estos límites.">
          <SwitchRow
            label="Aceptar reservas por la web"
            description="Si lo apagas, tu página pública dice que ahora no se puede reservar en línea."
            checked={s.publicBooking}
            onChange={(v) => set("publicBooking", v)}
          />
          <SwitchRow
            label="Confirmar las reservas solas"
            description="Si lo apagas, las reservas de la web quedan pendientes hasta que alguien del equipo las confirme."
            checked={s.autoConfirm}
            onChange={(v) => set("autoConfirm", v)}
          />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            <NumberField label="Grupo mínimo" unit="personas" min={1} value={s.minPartySize} error={errors.minPartySize} onChange={(t) => set("minPartySize", F.intFromInput(t))} />
            <NumberField label="Grupo máximo" unit="personas" min={1} value={s.maxPartySize} error={errors.maxPartySize} onChange={(t) => set("maxPartySize", F.intFromInput(t))} />
            <NumberField
              label="Antelación mínima"
              unit="min"
              min={0}
              value={s.minNoticeMinutes}
              error={errors.minNoticeMinutes}
              hint="Ej.: 60 para no aceptar reservas con menos de una hora."
              onChange={(t) => set("minNoticeMinutes", F.intFromInput(t))}
            />
            <NumberField
              label="Antelación máxima"
              unit="días"
              min={1}
              value={s.maxAdvanceDays}
              error={errors.maxAdvanceDays}
              onChange={(t) => set("maxAdvanceDays", F.intFromInput(t))}
            />
          </div>
        </Section>

        <Senal s={s} errors={errors} edit={edit} />

        <Section id="avisos" title="Cancelación, recordatorio y reseñas" description="Lo que se le dice al cliente y lo que se le envía solo.">
          <NumberField
            label="Cancelación gratis hasta"
            unit="horas antes"
            min={0}
            value={s.cancellation.freeUntilHours}
            error={errors["cancellation.freeUntilHours"]}
            hint="0 para que siempre se pueda cancelar gratis. Se enseña en la página y en los mensajes."
            onChange={(t) => set("cancellation", { freeUntilHours: F.intFromInput(t) })}
          />
          <div className="flex flex-wrap items-end gap-4">
            <SwitchRow
              className="min-w-64 flex-1"
              label="Recordatorio el día antes"
              description="Por correo o WhatsApp, a la hora que elijas."
              checked={s.reminders.dayBefore}
              onChange={(v) => set("reminders", { ...s.reminders, dayBefore: v })}
            />
            <div className="flex items-center gap-2">
              <Label htmlFor="hora-recordatorio" className="text-sm text-muted-foreground">
                a las
              </Label>
              <TimeInput
                id="hora-recordatorio"
                disabled={!s.reminders.dayBefore}
                value={s.reminders.hour}
                error={errors["reminders.hour"]}
                onChange={(v) => set("reminders", { ...s.reminders, hour: v })}
              />
            </div>
          </div>
          <SwitchRow
            label="Pedir una reseña en Google"
            description="El día siguiente a una reserva terminada, a las 12:00, con el enlace de tu ficha."
            checked={s.reviews.enabled}
            onChange={(v) => set("reviews", { ...s.reviews, enabled: v })}
          />
          {s.reviews.enabled ? (
            <TextField
              label="Enlace para dejar la reseña"
              type="url"
              inputMode="url"
              placeholder="https://g.page/r/…/review"
              value={s.reviews.googleReviewUrl ?? ""}
              error={errors["reviews.googleReviewUrl"]}
              hint={
                s.reviews.googleReviewUrl
                  ? "Lo encuentras en tu Perfil de Empresa de Google, en «Pedir reseñas»."
                  : "Sin enlace no se pide la reseña. Lo encuentras en tu Perfil de Empresa de Google, en «Pedir reseñas»."
              }
              onChange={(e) => set("reviews", { ...s.reviews, googleReviewUrl: e.target.value.trim() === "" ? null : e.target.value })}
            />
          ) : null}
        </Section>

        <Section id="espera" title="Lista de espera" description="Si no hay hora, el cliente puede apuntarse y se le avisa solo cuando se libera una mesa.">
          <SwitchRow label="Ofrecer la lista de espera" checked={s.waitlist.enabled} onChange={(v) => set("waitlist", { ...s.waitlist, enabled: v })} />
          {s.waitlist.enabled ? (
            <NumberField
              label="Tiempo para aceptar el hueco"
              unit="min"
              min={5}
              value={s.waitlist.offerMinutes}
              error={errors["waitlist.offerMinutes"]}
              hint="Lo que se guarda la mesa ofrecida antes de pasarla al siguiente."
              onChange={(t) => set("waitlist", { ...s.waitlist, offerMinutes: F.intFromInput(t) })}
            />
          ) : null}
        </Section>
      </div>

      <SaveBar
        className="rounded-xl border bg-popover shadow-float backdrop-blur-none"
        dirty={dirty}
        pending={pending}
        disabled={!validation.ok}
        onSave={() => void save()}
        onDiscard={() => {
          setDraft(null)
          setError(null)
        }}
        saveLabel="Guardar configuración"
        message={validation.ok ? "Hay cambios sin guardar." : `No se puede guardar: ${errorCount === 1 ? "hay un dato por revisar" : `hay ${errorCount} datos por revisar`}.`}
      />
    </>
  )
}

type EditProps = { s: F.Settings; errors: Record<string, string>; edit: (fn: (s: F.Settings) => F.Settings) => void }

function CopyDay({ from, s, edit }: { from: Weekday; s: F.Settings; edit: EditProps["edit"] }) {
  const [targets, setTargets] = useState<Weekday[]>([])
  const [open, setOpen] = useState(false)
  useCloseOnHide(() => {
    setOpen(false)
    setTargets([])
  })
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        setOpen(o)
        if (!o) setTargets([])
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="text-muted-foreground" disabled={s.week[from].length === 0}>
          <CopyIcon aria-hidden />
          Copiar
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-60">
        <fieldset className="flex flex-col gap-2">
          <legend className="mb-2 text-sm font-medium">Copiar el {F.weekdayLabel(from)} a</legend>
          {F.WEEKDAY_LABELS.filter(([d]) => d !== from).map(([d, name]) => (
            <div key={d} className="flex min-h-11 items-center gap-2">
              <Checkbox
                id={`copiar-${from}-${d}`}
                checked={targets.includes(d)}
                onCheckedChange={(v) => setTargets((t) => (v === true ? [...t, d] : t.filter((x) => x !== d)))}
              />
              <Label htmlFor={`copiar-${from}-${d}`} className="flex min-h-11 flex-1 items-center font-normal">
                {name}
              </Label>
            </div>
          ))}
        </fieldset>
        <Button
          size="sm"
          variant="outline"
          className="mt-3 w-full"
          disabled={targets.length === 0}
          onClick={() => {
            edit((x) => F.copyDay(x, from, targets))
            setOpen(false)
            setTargets([])
          }}
        >
          Copiar
        </Button>
      </PopoverContent>
    </Popover>
  )
}

function Semana({ s, errors, edit }: EditProps) {
  return (
    <Section id="semana" title="Horario de la semana" description="Turnos de cada día con la primera y la última hora de llegada. Un día sin turnos está cerrado.">
      <ul className="flex flex-col divide-y">
        {F.WEEKDAY_LABELS.map(([day, name]) => (
          <li key={day} className="flex flex-col gap-3 py-5 first:pt-0 last:pb-0 lg:flex-row lg:items-start">
            <div className="flex items-center justify-between lg:w-28 lg:shrink-0 lg:pt-1.5">
              <span className="text-sm font-medium capitalize">{name}</span>
              <span className="lg:hidden">
                <CopyDay from={day} s={s} edit={edit} />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <ShiftsEditor
                label={name}
                shifts={s.week[day]}
                path={`week.${day}`}
                errors={errors}
                onChange={(i, patch) => edit((x) => F.updateShift(x, day, i, patch))}
                onAdd={() => edit((x) => F.addShift(x, day))}
                onRemove={(i) => edit((x) => F.removeShift(x, day, i))}
              />
            </div>
            <span className="hidden lg:block">
              <CopyDay from={day} s={s} edit={edit} />
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">
        Los dos números de la derecha son opcionales: comensales que pueden llegar en una misma franja y en todo el turno. Si la última llegada es antes que la primera, el turno pasa de medianoche.
      </p>
    </Section>
  )
}

function Vista({ s, today }: { s: F.Settings; today: string }) {
  const [fecha, setFecha] = useState(today)
  const preview = F.previewSlots(s, fecha)
  return (
    <Section id="vista" title="Horas que se ofrecen" description="Así quedan las horas de un día con lo que tienes en pantalla, antes de guardar.">
      <div className="flex flex-wrap items-center gap-3">
        <Label htmlFor="vista-fecha">Día</Label>
        <DateInput clearable={false} id="vista-fecha" label="Día de las horas que se ofrecen" className="max-w-full" value={fecha} onChange={(value) => value && setFecha(value)} />
        <span className="text-sm text-muted-foreground capitalize">{F.weekdayLabel(F.weekdayOf(fecha))}</span>
      </div>
      {preview === null ? (
        <p className="text-sm text-muted-foreground">Corrige los datos marcados para ver las horas.</p>
      ) : preview.length === 0 ? (
        <p className="text-sm text-muted-foreground">Ese día está cerrado.</p>
      ) : (
        <dl className="flex flex-col gap-3">
          {preview.map((t) => (
            <div key={t.turno} className="flex flex-col gap-1.5 sm:flex-row sm:gap-4">
              <dt className="text-sm font-medium sm:w-24 sm:shrink-0">{t.turno}</dt>
              <dd className="cifra flex flex-wrap gap-1.5 text-xs">
                {t.horas.map((h) => (
                  <span key={h} className="rounded-md border bg-surface-sunken px-2 py-1 text-soft-foreground">
                    {h}
                  </span>
                ))}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </Section>
  )
}

function DiasEspeciales({ s, errors, edit, today }: EditProps & { today: string }) {
  const [fecha, setFecha] = useState("")
  return (
    <Section id="especiales" title="Días especiales" description="Festivos, eventos o un día con otro horario. Ganan a todo lo demás.">
      {s.exceptions.length === 0 ? <p className="text-sm text-muted-foreground">No hay días especiales.</p> : null}
      <ul className="flex flex-col divide-y">
        {s.exceptions.map((e, i) => (
          <li key={`${e.date}-${i}`} className="flex flex-col gap-3 py-3 first:pt-0">
            <div className="flex flex-wrap items-center gap-3">
              <DateInput
                label={`Fecha del día especial ${i + 1}`}
                className="max-w-full"
                value={e.date}
                aria-invalid={errors[`exceptions.${i}.date`] ? true : undefined}
                aria-describedby={errors[`exceptions.${i}.date`] ? `especial-fecha-error-${i}` : undefined}
                onChange={(date) => edit((x) => F.updateException(x, i, { ...e, date } as Exception))}
              />
              <SegmentedControl
                label={`Tipo del día ${e.date}`}
                value={e.type}
                onValueChange={(t) => t !== e.type && edit((x) => F.updateException(x, i, F.switchExceptionType(e)))}
                options={[
                  { value: "closed", label: "Cerrado" },
                  { value: "hours", label: "Otro horario" },
                ]}
              />
              <Input
                aria-label={`Motivo del día ${e.date}`}
                placeholder="Motivo (opcional)"
                maxLength={120}
                className="h-9 min-w-40 flex-1"
                value={e.reason ?? ""}
                onChange={(ev) => {
                  const reason = ev.target.value
                  const { reason: _old, ...rest } = e
                  void _old
                  edit((x) => F.updateException(x, i, (reason.trim() ? { ...rest, reason } : rest) as Exception))
                }}
              />
              <Button variant="ghost" size="icon" className="pointer-coarse:min-w-11" aria-label={`Quitar el día especial ${e.date}`} onClick={() => edit((x) => F.removeException(x, i))}>
                <XIcon aria-hidden />
              </Button>
            </div>
            {errors[`exceptions.${i}.date`] ? (
              <p id={`especial-fecha-error-${i}`} role="alert" className="text-xs text-destructive">
                {errors[`exceptions.${i}.date`]}
              </p>
            ) : null}
            {e.type === "hours" ? (
              <ShiftsEditor
                label={e.date}
                shifts={e.shifts}
                path={`exceptions.${i}.shifts`}
                errors={errors}
                emptyText="Añade al menos un turno o márcalo como cerrado."
                onChange={(j, patch) =>
                  edit((x) => F.updateException(x, i, { ...e, shifts: e.shifts.map((sh, k) => (k === j ? { ...sh, ...patch } : sh)) }))
                }
                onAdd={() => edit((x) => F.updateException(x, i, { ...e, shifts: [...e.shifts, { name: "Especial", from: "20:00", lastEntry: "22:30" }] }))}
                onRemove={(j) => edit((x) => F.updateException(x, i, { ...e, shifts: e.shifts.filter((_, k) => k !== j) }))}
              />
            ) : null}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <DateInput label="Fecha del día especial nuevo" className="max-w-full" min={today} value={fecha} onChange={setFecha} />
        <Button
          variant="outline"
          size="sm"
          disabled={!fecha}
          onClick={() => {
            edit((x) => F.addException(x, fecha, "closed"))
            setFecha("")
          }}
        >
          <PlusIcon aria-hidden />
          Añadir día especial
        </Button>
      </div>
    </Section>
  )
}

function Cierres({ s, errors, edit, today }: EditProps & { today: string }) {
  return (
    <Section id="cierres" title="Cierres" description="Vacaciones u obras: del primer al último día, los dos incluidos.">
      {s.closures.length === 0 ? <p className="text-sm text-muted-foreground">No hay cierres previstos.</p> : null}
      <ul className="flex flex-col gap-3">
        {s.closures.map((c, i) => (
          <li key={i} className="flex flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-muted-foreground">Del</span>
              <DateInput label={`Primer día del cierre ${i + 1}`} className="max-w-full" value={c.from} aria-invalid={errors[`closures.${i}.from`] ? true : undefined} aria-describedby={F.errorsUnder(errors, `closures.${i}`).length ? `cierre-error-${i}` : undefined} onChange={(from) => edit((x) => F.updateClosure(x, i, { from }))} />
              <span className="text-sm text-muted-foreground">al</span>
              <DateInput
                label={`Último día del cierre ${i + 1}`}
                className="max-w-full"
                value={c.to}
                aria-invalid={errors[`closures.${i}.to`] ? true : undefined}
                aria-describedby={F.errorsUnder(errors, `closures.${i}`).length ? `cierre-error-${i}` : undefined}
                onChange={(to) => edit((x) => F.updateClosure(x, i, { to }))}
              />
              <Input
                aria-label={`Motivo del cierre ${i + 1}`}
                placeholder="Motivo (opcional)"
                maxLength={120}
                className="h-9 min-w-40 flex-1"
                value={c.reason ?? ""}
                onChange={(e) => edit((x) => F.updateClosure(x, i, { reason: e.target.value }))}
              />
              <Button variant="ghost" size="icon" className="pointer-coarse:min-w-11" aria-label={`Quitar el cierre ${i + 1}`} onClick={() => edit((x) => F.removeClosure(x, i))}>
                <XIcon aria-hidden />
              </Button>
            </div>
            {F.errorsUnder(errors, `closures.${i}`).length > 0 ? (
              <p id={`cierre-error-${i}`} role="alert" className="text-xs text-destructive">
                {F.errorsUnder(errors, `closures.${i}`).join(" ")}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      <Button variant="outline" size="sm" className="self-start" onClick={() => edit((x) => F.addClosure(x, today, today))}>
        <PlusIcon aria-hidden />
        Añadir cierre
      </Button>
    </Section>
  )
}

function Senal({ s, errors, edit }: EditProps) {
  const [amountText, setAmountText] = useState<string | null>(null)
  const on = s.deposit.mode === "perPerson"
  return (
    <Section id="senal" title="Señal" description="Un importe por persona al reservar, para que no te dejen la mesa vacía. Se cobra con Stripe.">
      <SwitchRow
        label="Pedir señal al reservar por la web"
        description="Si Stripe no está configurado, la reserva queda pendiente y la página lo explica al cliente."
        checked={on}
        onChange={(v) =>
          edit((x) => ({
            ...x,
            deposit: v ? { ...x.deposit, mode: "perPerson", amountCents: x.deposit.amountCents || 1000 } : { ...x.deposit, mode: "none" },
          }))
        }
      />
      {on ? (
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label="Importe por persona"
            inputMode="decimal"
            className="cifra w-32"
            value={amountText ?? F.centsToInput(s.deposit.amountCents)}
            error={errors["deposit.amountCents"]}
            trailing={<span className="pr-2 text-sm text-muted-foreground">€</span>}
            onChange={(e) => {
              setAmountText(e.target.value)
              const cents = F.centsFromInput(e.target.value)
              edit((x) => ({ ...x, deposit: { ...x.deposit, amountCents: cents } }))
            }}
            onBlur={() => setAmountText(null)}
          />
          <NumberField
            label="A partir de"
            unit="personas"
            min={1}
            value={s.deposit.fromPartySize}
            error={errors["deposit.fromPartySize"]}
            hint={
              Number.isFinite(s.deposit.amountCents) && Number.isFinite(s.deposit.fromPartySize)
                ? `Un grupo de ${s.deposit.fromPartySize} pagaría ${F.money(s.deposit.amountCents * s.deposit.fromPartySize)}.`
                : undefined
            }
            onChange={(t) => edit((x) => ({ ...x, deposit: { ...x.deposit, fromPartySize: F.intFromInput(t) } }))}
          />
        </div>
      ) : null}
    </Section>
  )
}
