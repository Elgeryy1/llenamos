"use client"

/**
 * Reservar en un restaurante: local (si hay varios), personas, día y hora en una misma
 * pantalla con el botón fijo abajo; después los datos y la confirmación. Se usa en la
 * página `/r/[slug]` y, más compacta, en el widget.
 */
import { useAtribucion } from "@/lib/origen/useAtribucion"
import { CasillasPermiso, permisoInicial } from "@/components/origen/CasillasPermiso"
import { sumarDias, type AvailabilitySlot, type PublicRestaurant } from "@llenamos/core"
import { ArrowLeftIcon, PhoneIcon } from "@phosphor-icons/react"
import { useRouter } from "next/navigation"
import { useEffect, useMemo, useRef, useState } from "react"
import { SelectField, TextareaField, TextField } from "@/components/common/form-fields"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { callPublic } from "@/lib/publica/callables"
import { manageHref } from "@/lib/publica/enlaces"
import { describePublicError, isSlotGone, type ShownError } from "@/lib/publica/errores"
import { dayOptions, formatLongDate } from "@/lib/publica/fechas"
import { peopleLabel } from "@/lib/publica/i18n"
import {
  cancellationText,
  createBookingInput,
  dayStatus,
  depositForParty,
  depositPolicyText,
  EMPTY_GUEST,
  initialPartySize,
  money,
  partySizeButtons,
  partySizeExtra,
  phoneOf,
  SLOT_STATE_TEXT,
  slotState,
  telHref,
  validateGuest,
  type GuestErrors,
  type GuestForm,
} from "@/lib/publica/reserva"
import { BarraInferior, CampoTrampa, ENLACE, Ocupado, Opcion, Opcional, Opciones, Seccion } from "./bloques"
import { ListaEspera } from "./ListaEspera"
import { OtraFecha } from "./OtraFecha"
import { usePublic } from "./PublicContext"
import { PublicShell } from "./PublicShell"
import { useDisponibilidad } from "./useDisponibilidad"

type Paso = "elegir" | "datos" | "espera"

const POLICY_VERSION = (process.env.NEXT_PUBLIC_MARKETING_POLICY_VERSION ?? (process.env.NEXT_PUBLIC_USE_EMULATORS === "1" ? "demo-2026.1" : "")).trim()
const POLICY_URL = (process.env.NEXT_PUBLIC_MARKETING_POLICY_URL ?? (process.env.NEXT_PUBLIC_USE_EMULATORS === "1" ? "/privacidad" : "")).trim()
const MARKETING_POLICY_READY = Boolean(POLICY_VERSION && POLICY_URL)

const CAMPOS = ["name", "phone", "email", "notes", "acceptPolicy"] as const

export function ReservaApp({ restaurant, slug, today }: { restaurant: PublicRestaurant; slug: string; today: string }) {
  const { t, lang, variant, settings } = usePublic()
  const router = useRouter()
  const attribution = useAtribucion({ widget: variant === "widget" })
  const [marketingOptIn, setMarketingOptIn] = useState(() => permisoInicial(POLICY_VERSION))
  const locations = restaurant.locations
  const [locationId, setLocationId] = useState(locations[0]?.id ?? "")
  const [partySize, setPartySize] = useState(() => initialPartySize(restaurant.minPartySize, restaurant.maxPartySize))
  const [date, setDate] = useState(today)
  const [time, setTime] = useState<string | null>(null)
  const [paso, setPaso] = useState<Paso>("elegir")
  const [guest, setGuest] = useState<GuestForm>(EMPTY_GUEST)
  const [errors, setErrors] = useState<GuestErrors>({})
  const [sending, setSending] = useState(false)
  const [submitError, setSubmitError] = useState<ShownError | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const pasoMostrado = useRef<Paso>("elegir")

  const { state, recargar } = useDisponibilidad(settings, slug, locationId, date, partySize)
  const location = locations.find((l) => l.id === locationId) ?? locations[0]
  const phone = phoneOf(restaurant, locationId)
  const subtitle = locations.length === 1 && location ? [location.city].filter(Boolean).join("") : null

  // Al cambiar de paso, el foco va al título del paso (lectores de pantalla y teclado).
  // Se compara con el paso anterior (y no con «primera vez») para que el doble efecto de desarrollo no mueva la página al cargar.
  useEffect(() => {
    if (pasoMostrado.current === paso) return
    pasoMostrado.current = paso
    headingRef.current?.focus()
    headingRef.current?.scrollIntoView({ block: "start" })
  }, [paso])

  const chosen = time && state.status === "ok" ? state.data.slots.find((s) => s.time === time && s.available) : undefined
  const summary = [peopleLabel(t, partySize), date === today ? t("today") : formatLongDate(date, lang), time].filter(Boolean).join(" · ")
  const deposit = depositForParty(restaurant.deposit, partySize)

  function elegir(changes: { locationId?: string; partySize?: number; date?: string }) {
    if (changes.locationId !== undefined) setLocationId(changes.locationId)
    if (changes.partySize !== undefined) setPartySize(changes.partySize)
    if (changes.date !== undefined) setDate(changes.date)
    setTime(null)
    setSubmitError(null)
  }

  /** Cambia un dato y borra su error: el aviso desaparece en cuanto la persona lo corrige. */
  function cambiar<K extends keyof GuestForm>(field: K, value: GuestForm[K]) {
    setGuest((g) => ({ ...g, [field]: value }))
    setErrors((e) => (field in e ? { ...e, [field]: undefined } : e))
  }

  async function confirmar(event: React.FormEvent) {
    event.preventDefault()
    if (!chosen || !time || !attribution) return
    const checked = validateGuest(guest, t)
    if (!checked.ok) {
      setErrors(checked.errors)
      const first = CAMPOS.find((f) => checked.errors[f])
      if (first) document.querySelector<HTMLElement>(`[data-campo="${first}"]`)?.focus()
      return
    }
    setErrors({})
    setSending(true)
    setSubmitError(null)
    try {
      const out = await callPublic(
        settings,
        "crearReservaPublica",
        { ...createBookingInput(slug, { locationId, date, partySize, time }, checked.value, guest, lang, variant === "widget" ? "widget" : "web"), attribution, ...(MARKETING_POLICY_READY ? { marketingOptIn } : {}) },
      )
      const href = manageHref(slug, out.reference, out.manageToken, lang, true)
      router.push(variant === "widget" ? `${href}&embed=1` : href)
    } catch (error) {
      const shown = describePublicError(error, lang, t)
      setSubmitError(shown)
      setSending(false)
      if (isSlotGone(shown)) {
        setTime(null)
        recargar()
        setPaso("elegir")
      }
    }
  }

  const politicas = (
    <div className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
      {depositPolicyText(restaurant.deposit, lang, t) ? <p>{depositPolicyText(restaurant.deposit, lang, t)}</p> : null}
      <p>{cancellationText(restaurant.cancellationFreeUntilHours, t)}</p>
    </div>
  )

  return (
    <PublicShell name={restaurant.name} brandColor={restaurant.brandColor} subtitle={paso === "elegir" ? subtitle : null} wide={paso === "elegir" && variant !== "widget"}>
      {paso === "elegir" ? (
        <div className="flex flex-1 flex-col gap-4 sm:gap-5">
          <h2 ref={headingRef} tabIndex={-1} className="sr-only">
            {t("metaTitle", { name: restaurant.name })}
          </h2>
          {submitError ? <Notice tone="error" title={submitError.message} /> : null}

          <div className={variant === "widget" ? "grid min-w-0 gap-4" : "grid min-w-0 items-start gap-4 lg:grid-cols-2"}>
            <div className="flex min-w-0 flex-col gap-4">
              {locations.length > 1 ? (
                <Seccion title={t("location")} id="sec-local">
                  <Opciones labelledBy="sec-local" value={locationId} onChange={(id) => elegir({ locationId: id })} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {locations.map((l) => (
                      <Opcion key={l.id} value={l.id} className="flex h-auto min-h-12 flex-col items-start justify-center px-4 py-2 text-left font-sans whitespace-normal">
                        <span className="font-medium">{l.name}</span>
                        {l.address || l.city ? <span className="text-[13px] opacity-80">{[l.address, l.city].filter(Boolean).join(", ")}</span> : null}
                      </Opcion>
                    ))}
                  </Opciones>
                </Seccion>
              ) : null}

              <Personas restaurant={restaurant} value={partySize} phone={phone} onChange={(n) => elegir({ partySize: n })} />
              <Dias today={today} maxAdvanceDays={restaurant.maxAdvanceDays} value={date} onChange={(d) => elegir({ date: d })} />
            </div>
            <div className="flex min-w-0 flex-col gap-4">
              <Horas
                state={state}
                value={time}
                onChange={(v) => {
                  setTime(v)
                  setSubmitError(null)
                }}
                onRetry={recargar}
                onWaitlist={() => setPaso("espera")}
                restaurant={restaurant}
              />
              {politicas}
            </div>
          </div>

          <BarraInferior>
            <p className="text-center text-[13px] text-muted-foreground" aria-live="polite">
              {summary}
            </p>
            <Button size="xl" className="w-full" disabled={!chosen} onClick={() => setPaso("datos")}>
              {chosen ? t("continue") : t("chooseTime")}
            </Button>
          </BarraInferior>
        </div>
      ) : null}

      {paso === "datos" && chosen ? (
        <form noValidate onSubmit={confirmar} className="flex flex-1 flex-col gap-6">
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="icon-lg" onClick={() => setPaso("elegir")} className="-ml-2 size-11" aria-label={t("back")}>
              <ArrowLeftIcon aria-hidden className="size-5" />
            </Button>
            <h2 ref={headingRef} tabIndex={-1} className="text-[24px] leading-tight font-semibold tracking-tight outline-none sm:text-[32px]">
              {t("yourDetails")}
            </h2>
          </div>

          <section aria-label={t("yourBooking")} className="superficie overflow-hidden rounded-2xl">
            <div className="flex items-center justify-between gap-3 px-4 py-2">
              <span className="text-sm">
                <span className="cifra">{peopleLabel(t, partySize)}</span> · {formatLongDate(date, lang)} · <span className="cifra">{time}</span>
              </span>
              <Button variant="link" onClick={() => setPaso("elegir")} className="h-11 px-0 text-[var(--brand-text)]">
                {t("back")}
              </Button>
            </div>
            {locations.length > 1 && location ? <p className="border-t px-4 py-3 text-[13px] text-muted-foreground">{location.name}</p> : null}
          </section>

          {submitError ? <Notice tone="error" title={submitError.message} /> : null}
          {Object.values(errors).some(Boolean) ? (
            <p className="sr-only" role="alert">
              {t("errFix")}
            </p>
          ) : null}

          <div className="superficie flex flex-col gap-5 rounded-2xl p-4 sm:p-5">
            <TextField
              data-campo="name"
              label={t("name")}
              autoComplete="name"
              value={guest.name}
              error={errors.name}
              onChange={(e) => cambiar("name", e.target.value)}
              maxLength={80}
              required
              className="h-12 text-base"
            />
            <TextField
              data-campo="phone"
              label={t("phone")}
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              value={guest.phone}
              error={errors.phone}
              hint={t("phoneHint")}
              onChange={(e) => cambiar("phone", e.target.value)}
              maxLength={40}
              required
              className="h-12 text-base"
            />
            <TextField
              data-campo="email"
              label={<Opcional label={t("email")} />}
              type="email"
              inputMode="email"
              autoComplete="email"
              value={guest.email}
              error={errors.email}
              onChange={(e) => cambiar("email", e.target.value)}
              maxLength={254}
              className="h-12 text-base"
            />
            <TextareaField
              data-campo="notes"
              label={<Opcional label={t("notes")} />}
              hint={t("notesHint")}
              value={guest.notes}
              error={errors.notes}
              onChange={(e) => cambiar("notes", e.target.value)}
              maxLength={500}
              rows={3}
              className="min-h-24 text-base"
            />
            <CampoTrampa value={guest.website} onChange={(website) => setGuest({ ...guest, website })} />
          </div>

          <div className="flex flex-col gap-3">
            {deposit > 0 ? <Notice tone="warning" title={t("depositThisBooking", { amount: money(deposit, lang) })} /> : null}
            {politicas}
            {MARKETING_POLICY_READY ? <CasillasPermiso policyVersion={POLICY_VERSION} policyUrl={POLICY_URL} value={marketingOptIn} onChange={setMarketingOptIn} disabled={sending} /> : null}
            <Field orientation="horizontal" data-invalid={errors.acceptPolicy ? true : undefined} className="items-start">
              <Checkbox
                id="reserva-acceptPolicy"
                data-campo="acceptPolicy"
                checked={guest.acceptPolicy}
                onCheckedChange={(v) => cambiar("acceptPolicy", v === true)}
                aria-invalid={errors.acceptPolicy ? true : undefined}
                aria-describedby={errors.acceptPolicy ? "reserva-acceptPolicy-error" : undefined}
                className="mt-0.5 size-5"
              />
              <div className="flex flex-col gap-1">
                <FieldLabel htmlFor="reserva-acceptPolicy" className="min-h-6 text-sm font-normal">
                  {t("acceptPolicy")}
                </FieldLabel>
                {errors.acceptPolicy ? <FieldError id="reserva-acceptPolicy-error">{errors.acceptPolicy}</FieldError> : null}
              </div>
            </Field>
            <p className="text-[12.5px] text-muted-foreground">{t("privacy", { name: restaurant.name })}</p>
          </div>

          <BarraInferior>
            <p className="text-center text-[13px] text-muted-foreground">{summary}</p>
            <Button type="submit" size="xl" className="w-full" disabled={sending}>
              <Ocupado busy={sending} />
              {sending ? t("booking") : t("confirmBooking")}
            </Button>
          </BarraInferior>
        </form>
      ) : null}

      {paso === "espera" ? (
        <ListaEspera
          headingRef={headingRef}
          slug={slug}
          locationId={locationId}
          date={date}
          partySize={partySize}
          slots={state.status === "ok" ? state.data.slots : []}
          onBack={() => setPaso("elegir")}
        />
      ) : null}
    </PublicShell>
  )
}

/* Personas ------------------------------------------------------------------ */

function Personas({
  restaurant,
  value,
  phone,
  onChange,
}: {
  restaurant: PublicRestaurant
  value: number
  phone: string | null
  onChange: (n: number) => void
}) {
  const { t } = usePublic()
  const buttons = partySizeButtons(restaurant.minPartySize, restaurant.maxPartySize)
  const extra = partySizeExtra(restaurant.minPartySize, restaurant.maxPartySize)
  return (
    <Seccion title={t("people")} id="sec-personas">
      <Opciones labelledBy="sec-personas" value={String(value)} onChange={(v) => onChange(Number(v))} className="grid grid-cols-4 gap-2">
        {buttons.map((n) => (
          <Opcion key={n} value={String(n)} aria-label={peopleLabel(t, n)} className="h-12">
            {n}
          </Opcion>
        ))}
      </Opciones>
      {extra.length > 0 ? (
        <SelectField
          touchSize={48}
          label={t("morePeople")}
          value={extra.includes(value) ? String(value) : ""}
          onChange={(e) => e.target.value && onChange(Number(e.target.value))}
          className="h-12 text-base"
        >
          <option value="">{t("morePeopleChoose")}</option>
          {extra.map((n) => (
            <option key={n} value={n}>
              {peopleLabel(t, n)}
            </option>
          ))}
        </SelectField>
      ) : null}
      <p className="text-[13px] text-muted-foreground">
        {phone ? (
          <>
            {t("bigGroupCall", { max: restaurant.maxPartySize })}{" "}
            <a href={telHref(phone)} className={ENLACE}>
              <PhoneIcon aria-hidden className="size-3.5" />
              {phone}
            </a>
          </>
        ) : (
          t("bigGroupWrite", { max: restaurant.maxPartySize })
        )}
      </p>
    </Seccion>
  )
}

/* Día ----------------------------------------------------------------------- */

const STRIP_DAYS = 14

function Dias({ today, maxAdvanceDays, value, onChange }: { today: string; maxAdvanceDays: number; value: string; onChange: (d: string) => void }) {
  const { t, lang } = usePublic()
  // Dos semanas a mano; para más adelante, el calendario.
  const days = useMemo(() => dayOptions(today, maxAdvanceDays, lang, t, STRIP_DAYS), [today, maxAdvanceDays, lang, t])
  const lastDay = sumarDias(today, maxAdvanceDays)
  const inStrip = days.some((d) => d.date === value)
  return (
    <Seccion title={t("day")} id="sec-dia">
      <Opciones
        labelledBy="sec-dia"
        value={inStrip ? value : ""}
        onChange={onChange}
        className="no-scrollbar w-full snap-x justify-start gap-2 overflow-x-auto pb-1"
      >
        {days.map((d) => (
          <Opcion
            key={d.date}
            value={d.date}
            aria-label={d.accessible}
            className="group/dia flex h-[66px] w-[62px] shrink-0 snap-start flex-col items-center justify-center gap-0.5 font-sans"
          >
            <span className="text-xs text-muted-foreground group-data-[state=on]/dia:text-[var(--brand-text)]">{d.label}</span>
            <span className="cifra text-[17px]">{d.day}</span>
          </Opcion>
        ))}
      </Opciones>
      {maxAdvanceDays >= STRIP_DAYS ? <OtraFecha value={value} first={today} last={lastDay} highlighted={!inStrip} onChange={onChange} /> : null}
    </Seccion>
  )
}

/* Hora ---------------------------------------------------------------------- */

function Horas({
  state,
  value,
  onChange,
  onRetry,
  onWaitlist,
  restaurant,
}: {
  state: ReturnType<typeof useDisponibilidad>["state"]
  value: string | null
  onChange: (time: string) => void
  onRetry: () => void
  onWaitlist: () => void
  restaurant: PublicRestaurant
}) {
  const { t, lang } = usePublic()

  let body: React.ReactNode
  let waitlist = false
  if (state.status === "loading") {
    body = (
      <LoadingBlock label={t("loadingSlots")}>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-20" />
          <div className="grid grid-cols-4 gap-2">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-11 rounded-xl" />
            ))}
          </div>
        </div>
      </LoadingBlock>
    )
  } else if (state.status === "error") {
    const shown = describePublicError(state.error, lang, t)
    body = (
      <Notice
        tone="error"
        title={t("slotsError")}
        action={
          <Button variant="outline" size="lg" onClick={onRetry} className="h-11">
            {t("retry")}
          </Button>
        }
      >
        {shown.message}
      </Notice>
    )
  } else {
    const day = dayStatus(state.data, lang)
    waitlist = state.data.waitlistEnabled && day.kind !== "closed" && day.kind !== "party_size_not_allowed"
    if (day.kind === "closed") body = <p className="text-sm text-muted-foreground">{t("closedDay")}</p>
    else if (day.kind === "party_size_not_allowed")
      body = <p className="text-sm text-muted-foreground">{t("partyNotAllowed", { min: restaurant.minPartySize, max: restaurant.maxPartySize })}</p>
    else if (day.kind === "no_slots") body = <p className="text-sm text-muted-foreground">{t("noSlots")}</p>
    else
      body = (
        <>
          {!day.anyAvailable ? <p className="text-sm text-muted-foreground">{t("noSlots")}</p> : null}
          {day.groups.map((g) => {
            const titleId = `sec-hora-${g.shift}`
            return (
              <div key={g.shift} className="flex flex-col gap-3 border-t pt-3 first:border-0 first:pt-0">
                <h3 id={titleId} className="text-[13px] text-soft-foreground">
                  {g.label}
                </h3>
                <Opciones labelledBy={titleId} value={value && g.slots.some((s) => s.time === value) ? value : ""} onChange={onChange} className="grid grid-cols-4 gap-2">
                  {g.slots.map((s) => (
                    <BotonHora key={`${s.wallDate}-${s.time}`} slot={s} />
                  ))}
                </Opciones>
              </div>
            )
          })}
        </>
      )
  }

  return (
    <Seccion title={t("time")} id="sec-hora" className="gap-3.5">
      {body}
      {waitlist ? (
        <p className="text-[13px] text-muted-foreground">
          {t("waitlistQuestion")}{" "}
          <button type="button" onClick={onWaitlist} className={`${ENLACE} underline`}>
            {t("waitlistLink")}
          </button>{" "}
          {t("waitlistQuestionEnd")}
        </p>
      ) : null}
    </Seccion>
  )
}

function BotonHora({ slot }: { slot: AvailabilitySlot }) {
  const { t } = usePublic()
  const estado = slotState(slot)
  const unavailable = estado !== "available"
  return (
    <Opcion value={slot.time} disabled={unavailable} aria-label={unavailable ? `${slot.time}, ${t(SLOT_STATE_TEXT[estado])}` : slot.time} className="text-sm">
      {slot.time}
    </Opcion>
  )
}
