"use client"

/** Apuntarse a la lista de espera de un día (`apuntarseListaEspera`). */
import type { AvailabilitySlot } from "@llenamos/core"
import { ArrowLeftIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { callPublic } from "@/lib/publica/callables"
import { describePublicError, type ShownError } from "@/lib/publica/errores"
import { formatLongDate } from "@/lib/publica/fechas"
import { peopleLabel } from "@/lib/publica/i18n"
import { validateContact, waitlistTimes, type GuestErrors } from "@/lib/publica/reserva"
import { BarraInferior, CampoTrampa, Ocupado, Opcional } from "./bloques"
import { usePublic } from "./PublicContext"

type Errores = GuestErrors & { range?: string }

const SELECT = "h-12 text-base"
const INPUT = "h-12 text-base"

export function ListaEspera({
  headingRef,
  slug,
  locationId,
  date,
  partySize,
  slots,
  onBack,
}: {
  headingRef: React.RefObject<HTMLHeadingElement | null>
  slug: string
  locationId: string
  date: string
  partySize: number
  slots: AvailabilitySlot[]
  onBack: () => void
}) {
  const { t, lang, variant, settings } = usePublic()
  const times = waitlistTimes(slots)
  const [form, setForm] = useState({ name: "", phone: "", email: "", website: "" })
  const [from, setFrom] = useState(times[0] ?? "")
  const [to, setTo] = useState(times.at(-1) ?? "")
  const [errors, setErrors] = useState<Errores>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)
  const [done, setDone] = useState(false)

  /** Cambia un dato y borra su error. */
  function cambiar(field: "name" | "phone" | "email" | "website", value: string) {
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => (field in e ? { ...e, [field]: undefined } : e))
  }

  async function enviar(event: React.FormEvent) {
    event.preventDefault()
    const contact = validateContact(form, t)
    // Se compara la posición en el día (un turno puede cruzar la medianoche: 23:30 va antes que 00:15).
    const range = times.indexOf(from) > times.indexOf(to) ? t("errWaitlistRange") : undefined
    if (!contact.value || range) {
      setErrors({ ...contact.errors, range })
      return
    }
    setErrors({})
    setSending(true)
    setError(null)
    try {
      await callPublic(settings, "apuntarseListaEspera", {
        slug,
        locationId,
        date,
        from,
        to,
        partySize,
        guestName: contact.value.guestName,
        phone: contact.value.phone,
        email: contact.value.email,
        language: lang,
        source: variant === "widget" ? "widget" : "web",
        website: form.website,
      })
      setDone(true)
    } catch (e) {
      setError(describePublicError(e, lang, t))
    } finally {
      setSending(false)
    }
  }

  const header = (
    <div className="flex items-center gap-1">
      <Button variant="ghost" size="icon-lg" onClick={onBack} className="-ml-2 size-11" aria-label={t("back")}>
        <ArrowLeftIcon aria-hidden className="size-5" />
      </Button>
      <h2 ref={headingRef} tabIndex={-1} className="text-[24px] leading-tight font-semibold tracking-tight outline-none sm:text-[32px]">
        {done ? t("waitlistDoneTitle") : t("waitlistTitle")}
      </h2>
    </div>
  )

  if (done) {
    return (
      <div className="flex flex-1 flex-col gap-5">
        {header}
        <Notice tone="success">{t("waitlistDoneBody", { from, to })}</Notice>
        <Button variant="outline" size="xl" className="w-full" onClick={onBack}>
          {t("backToTimes")}
        </Button>
      </div>
    )
  }

  return (
    <form noValidate onSubmit={enviar} className="flex flex-1 flex-col gap-5">
      {header}
      <p className="text-sm text-muted-foreground">{t("waitlistIntro", { people: peopleLabel(t, partySize), date: formatLongDate(date, lang) })}</p>
      {error ? <Notice tone="error" title={error.message} /> : null}
      <div className="superficie grid grid-cols-2 items-start gap-3 rounded-2xl p-4 sm:p-5">
        <SelectField
          touchSize={48}
          label={t("from")}
          value={from}
          className={SELECT}
          onChange={(e) => {
            setFrom(e.target.value)
            setErrors((x) => ({ ...x, range: undefined }))
          }}
        >
          {times.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </SelectField>
        <SelectField
          touchSize={48}
          label={t("to")}
          value={to}
          error={errors.range}
          className={SELECT}
          onChange={(e) => {
            setTo(e.target.value)
            setErrors((x) => ({ ...x, range: undefined }))
          }}
        >
          {times.map((h) => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </SelectField>
      </div>
      <div className="superficie flex flex-col gap-5 rounded-2xl p-4 sm:p-5">
        <TextField label={t("name")} autoComplete="name" value={form.name} error={errors.name} maxLength={80} className={INPUT} onChange={(e) => cambiar("name", e.target.value)} />
        <TextField
          label={t("phone")}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          value={form.phone}
          error={errors.phone}
          hint={t("phoneHint")}
          maxLength={40}
          className={INPUT}
          onChange={(e) => cambiar("phone", e.target.value)}
        />
        <TextField
          label={<Opcional label={t("email")} />}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={form.email}
          error={errors.email}
          maxLength={254}
          className={INPUT}
          onChange={(e) => cambiar("email", e.target.value)}
        />
        <CampoTrampa value={form.website} onChange={(website) => cambiar("website", website)} />
      </div>
      <BarraInferior>
        <Button type="submit" size="xl" className="w-full" disabled={sending || times.length === 0}>
          <Ocupado busy={sending} />
          {sending ? t("joining") : t("joinWaitlist")}
        </Button>
      </BarraInferior>
    </form>
  )
}
