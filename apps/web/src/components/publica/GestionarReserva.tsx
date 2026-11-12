"use client"

/**
 * Ver y gestionar una reserva con el enlace (`verReservaPublica`, `gestionarReservaPublica`
 * e `iniciarPagoSenal`). También es la pantalla de «reserva confirmada» justo después de
 * reservar (`?nueva=1`).
 */
import type { PublicReservationView, PublicRestaurant } from "@llenamos/core"
import { CalendarPlusIcon, CheckIcon, CopyIcon, MapPinIcon, PhoneIcon } from "@phosphor-icons/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { SummaryList } from "@/components/common/summary-list"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { ESTADO_DE_STATUS, StatusPill } from "@/components/common/reservation-status"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/cn"
import { brandStyle } from "@/lib/publica/brand"
import styles from "./publica.module.css"
import { useCloseOnHide } from "@/lib/open-state"
import { callPublic } from "@/lib/publica/callables"
import { bookingHref, calendarFile, mapsHref } from "@/lib/publica/enlaces"
import { describePublicError, type ShownError } from "@/lib/publica/errores"
import { formatLongDate, wallOf } from "@/lib/publica/fechas"
import { peopleLabel, type TextKey, type Translate } from "@/lib/publica/i18n"
import { cancellationText, money, phoneOf, telHref } from "@/lib/publica/reserva"
import { ENLACE, Ocupado } from "./bloques"
import { usePublic } from "./PublicContext"
import { PublicShell } from "./PublicShell"

type Estado = { status: "loading" } | { status: "error"; error: ShownError } | { status: "ok"; view: PublicReservationView }

const STATUS_TEXT: Record<PublicReservationView["status"], TextKey> = {
  pending: "statusPending",
  confirmed: "statusConfirmed",
  seated: "statusSeated",
  finished: "statusFinished",
  cancelled: "statusCancelled",
  no_show: "statusNoShow",
}

function depositText(view: PublicReservationView, t: Translate, lang: Parameters<typeof money>[1]): string {
  const amount = money(view.deposit.amountCents, lang)
  switch (view.deposit.status) {
    case "none":
      return t("depositNone")
    case "paid":
      return t("depositPaid", { amount })
    case "required":
      return t("depositDue", { amount })
    case "refunded":
      return t("depositRefunded", { amount })
    case "not_configured":
      return t("depositInactive", { amount })
    case "failed":
      return t("depositFailed", { amount })
  }
}

/** El enlace de gestión tal cual, sin las marcas de «recién reservada» ni de widget. */
function enlaceLimpio(): string {
  const url = new URL(window.location.href)
  url.searchParams.delete("nueva")
  url.searchParams.delete("embed")
  return url.toString()
}

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? name
}

export function GestionarReserva({
  restaurant,
  slug,
  reference,
  token,
  isNew,
}: {
  restaurant: PublicRestaurant
  slug: string
  reference: string
  token: string | null
  isNew: boolean
}) {
  const { t, lang, settings } = usePublic()
  const [estado, setEstado] = useState<Estado>(() =>
    token
      ? { status: "loading" }
      : {
          status: "error",
          error: { key: "missingToken", message: "", code: "token" },
        },
  )
  const [version, setVersion] = useState(0)
  const [busy, setBusy] = useState<null | "cancel" | "confirm" | "pay">(null)
  const [actionError, setActionError] = useState<ShownError | null>(null)
  const [payMessage, setPayMessage] = useState<string | null>(null)
  const [lateCancel, setLateCancel] = useState(false)
  const [cancelOpen, setCancelOpen] = useState(false)
  useCloseOnHide(() => setCancelOpen(false))
  const keepRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!token) return
    const controller = new AbortController()
    callPublic(settings, "verReservaPublica", { slug, reference, token }, { signal: controller.signal })
      .then((view) => setEstado({ status: "ok", view }))
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setEstado({
            status: "error",
            error: describePublicError(error, lang, t),
          })
      })
    return () => controller.abort()
    // El idioma no vuelve a pedir la reserva: el mensaje de error se traduce al enseñarlo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, slug, reference, token, version])

  const recargar = useCallback(() => {
    setEstado({ status: "loading" })
    setVersion((v) => v + 1)
  }, [])

  async function gestionar(action: "confirm" | "cancel") {
    if (!token) return
    setBusy(action)
    setActionError(null)
    try {
      const view = await callPublic(settings, "gestionarReservaPublica", {
        slug,
        reference,
        token,
        action,
      })
      setEstado({ status: "ok", view })
      setCancelOpen(false)
    } catch (error) {
      setActionError(describePublicError(error, lang, t))
    } finally {
      setBusy(null)
    }
  }

  async function pagar() {
    if (!token) return
    setBusy("pay")
    setActionError(null)
    setPayMessage(null)
    try {
      const out = await callPublic(settings, "iniciarPagoSenal", {
        slug,
        reference,
        token,
      })
      if (out.status === "redirect") {
        window.location.assign(out.url)
        return
      }
      if (out.status === "not_configured") setPayMessage(lang === "es" ? out.message : t("depositNotConfiguredTitle"))
      else recargar()
    } catch (error) {
      setActionError(describePublicError(error, lang, t))
    }
    setBusy(null)
  }

  if (estado.status === "loading") {
    return (
      <PublicShell name={restaurant.name} brandColor={restaurant.brandColor} compactHeader>
        <LoadingBlock label={t("loadingBooking")}>
          <div className="flex flex-col gap-6">
            <Skeleton className="size-10 rounded-full" />
            <Skeleton className="h-8 w-3/4" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-48 w-full rounded-xl" />
          </div>
        </LoadingBlock>
      </PublicShell>
    )
  }

  if (estado.status === "error") {
    const message = estado.error.key === "missingToken" ? t("missingToken") : estado.error.key ? t(estado.error.key) : estado.error.message
    return (
      <PublicShell name={restaurant.name} brandColor={restaurant.brandColor} compactHeader>
        <div className="flex flex-col gap-5">
          <h1 className="text-[24px] leading-tight font-semibold tracking-tight sm:text-[32px]">{message}</h1>
          <div className="flex flex-col gap-2">
            {estado.error.key !== "missingToken" && estado.error.key !== "errInvalidLink" ? (
              <Button variant="outline" size="xl" className="w-full" onClick={recargar}>
                {t("retry")}
              </Button>
            ) : null}
            <Button asChild variant="outline" size="xl" className="w-full">
              <a href={bookingHref(slug, lang)}>{t("newBooking")}</a>
            </Button>
          </div>
        </div>
      </PublicShell>
    )
  }

  const view = estado.view
  return (
    <Reserva
      view={view}
      restaurant={restaurant}
      slug={slug}
      isNew={isNew}
      busy={busy}
      actionError={actionError}
      payMessage={payMessage}
      cancelOpen={cancelOpen}
      keepRef={keepRef}
      lateCancel={lateCancel}
      onPay={pagar}
      onRefresh={recargar}
      onManage={gestionar}
      onCancelOpen={(open) => {
        setCancelOpen(open)
        if (open) {
          // Se calcula al abrir (no al pintar, que tiene que ser puro).
          setLateCancel(view.freeCancellationUntil !== null && Date.now() > view.freeCancellationUntil)
          setActionError(null)
        }
      }}
    />
  )
}

function Reserva({
  view,
  restaurant,
  slug,
  isNew,
  busy,
  actionError,
  payMessage,
  cancelOpen,
  keepRef,
  lateCancel,
  onPay,
  onRefresh,
  onManage,
  onCancelOpen,
}: {
  view: PublicReservationView
  restaurant: PublicRestaurant
  slug: string
  isNew: boolean
  busy: null | "cancel" | "confirm" | "pay"
  actionError: ShownError | null
  payMessage: string | null
  cancelOpen: boolean
  keepRef: React.RefObject<HTMLButtonElement | null>
  lateCancel: boolean
  onPay: () => void
  onRefresh: () => void
  onManage: (action: "confirm" | "cancel") => void
  onCancelOpen: (open: boolean) => void
}) {
  const { t, lang } = usePublic()
  const marca = brandStyle(restaurant.brandColor) as React.CSSProperties
  const [copied, setCopied] = useState(false)
  const { date, time } = wallOf(view.startAt, view.timezone)
  const location = restaurant.locations.find((l) => l.id === view.locationId)
  const map = location ? mapsHref(location, restaurant.name) : null
  const phone = phoneOf(restaurant, view.locationId)
  const name = firstName(view.guestName)
  const unpaid = view.deposit.status === "required" || view.deposit.status === "failed"
  const active = view.status === "pending" || view.status === "confirmed"

  let icon: "ok" | "wait" | "off" = "ok"
  let title: string
  let body: string | null = null
  if (view.status === "confirmed") title = t("confirmedTitle", { name })
  else if (view.status === "pending" && unpaid) {
    icon = "wait"
    title = t("depositRequiredTitle")
    body =
      view.deposit.status === "failed"
        ? t("depositFailedBody")
        : t("depositRequiredBody", {
            amount: money(view.deposit.amountCents, lang),
          })
  } else if (view.status === "pending" && view.deposit.status === "not_configured") {
    icon = "wait"
    title = t("depositNotConfiguredTitle")
    body = t("depositNotConfiguredBody", {
      amount: money(view.deposit.amountCents, lang),
    })
  } else if (view.status === "pending") {
    icon = "wait"
    title = t("pendingTitle", { name })
    body = t("pendingBody")
  } else if (view.status === "seated") title = t("seatedTitle")
  else if (view.status === "finished") title = t("finishedTitle", { name })
  else if (view.status === "cancelled") {
    icon = "off"
    title = t("cancelledTitle")
    body = t("cancelledBody")
  } else {
    icon = "off"
    title = t("noShowTitle")
    body = t("noShowBody")
  }

  function descargarCalendario() {
    const ics = calendarFile({
      uid: `${slug}-${view.reference}`,
      title: t("calendarTitle", { name: restaurant.name }),
      description: t("calendarDescription", {
        reference: view.reference,
        people: peopleLabel(t, view.partySize),
      }),
      location: location ? [location.address, location.city].filter(Boolean).join(", ") : view.locationName,
      startAt: view.startAt,
      durationMinutes: view.durationMinutes,
      url: enlaceLimpio(),
      now: Date.now(),
    })
    const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = `reserva-${view.reference}.ics`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  async function copiarEnlace() {
    const link = enlaceLimpio()
    try {
      await navigator.clipboard.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch {
      window.prompt(t("copyLink"), link)
    }
  }

  return (
    <PublicShell name={restaurant.name} brandColor={restaurant.brandColor} compactHeader>
      <div className="flex flex-col gap-6">
        <header className="flex flex-col gap-2.5 pt-2">
          <span
            aria-hidden
            className={cn(
              "flex size-10 items-center justify-center rounded-full",
              icon === "ok" && "bg-success/15 text-success",
              icon === "wait" && "bg-warning/15 text-warning",
              icon === "off" && "bg-destructive/15 text-destructive",
            )}
          >
            {icon === "ok" ? <CheckIcon weight="bold" className="size-5" /> : <span className="size-2.5 rounded-full border-2 border-current" />}
          </span>
          <h1 className="text-[24px] leading-tight font-semibold tracking-tight sm:text-[32px] text-balance">{title}</h1>
          {body ? <p className="text-sm text-muted-foreground">{body}</p> : null}
        </header>

        {actionError && !cancelOpen ? <Notice tone="error" title={actionError.message} /> : null}
        {payMessage ? <Notice tone="info" title={payMessage} /> : null}

        <section aria-label={t("yourBooking")} className="superficie overflow-hidden rounded-2xl">
          <div className="flex items-center justify-between gap-3 px-4 py-3.5">
            <span className="text-[13px] text-muted-foreground">{t("reference")}</span>
            <span className="cifra text-[17px] tracking-[0.08em]">{view.reference}</span>
          </div>
          <SummaryList
            items={[
              {
                label: t("day"),
                value: <span className="block first-letter:uppercase">{formatLongDate(date, lang)}</span>,
              },
              { label: t("time"), value: time, mono: true },
              { label: t("people"), value: view.partySize, mono: true },
              { label: t("deposit"), value: depositText(view, t, lang) },
              {
                label: t("status"),
                value: <StatusPill estado={ESTADO_DE_STATUS[view.status]} label={t(STATUS_TEXT[view.status])} className="mt-1" />,
                wide: true,
              },
            ]}
          />
          {view.guestNotes ? (
            <div className="flex flex-col gap-0.5 px-4 py-3.5">
              <span className="text-xs text-muted-foreground">{t("yourNotes")}</span>
              <span className="text-sm whitespace-pre-line">{view.guestNotes}</span>
            </div>
          ) : null}
        </section>

        <div className="flex flex-col gap-2">
          {unpaid && active ? (
            <>
              <Button size="xl" className="w-full" disabled={busy === "pay"} onClick={onPay}>
                <Ocupado busy={busy === "pay"} />
                {busy === "pay" ? t("openingPayment") : t("payDeposit")}
              </Button>
              <p className="text-[12.5px] text-muted-foreground">
                {t("depositProcessing")}{" "}
                <button type="button" onClick={onRefresh} className={cn(ENLACE, "underline")}>
                  {t("refresh")}
                </button>
              </p>
            </>
          ) : null}
          {view.canConfirm && view.status === "pending" ? (
            <Button
              size="xl"
              variant={unpaid ? "outline" : "default"}
              className="w-full"
              disabled={busy === "confirm"}
              onClick={() => onManage("confirm")}
            >
              <Ocupado busy={busy === "confirm"} />
              {busy === "confirm" ? t("confirming") : t("confirmAttendance")}
            </Button>
          ) : null}
          {active ? (
            <Button size="xl" variant="outline" className="w-full" onClick={descargarCalendario}>
              <CalendarPlusIcon aria-hidden />
              {t("addToCalendar")}
            </Button>
          ) : null}
          <div className="grid grid-cols-1 gap-2 min-[400px]:grid-cols-2">
            <Button size="xl" variant="outline" onClick={copiarEnlace} aria-live="polite">
              {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
              {copied ? t("linkCopied") : t("copyLink")}
            </Button>
            {view.canCancel ? (
              <Button size="xl" variant="destructive" onClick={() => onCancelOpen(true)}>
                {t("cancelBooking")}
              </Button>
            ) : (
              <Button asChild size="xl" variant="outline">
                <a href={bookingHref(slug, lang)}>{t("newBooking")}</a>
              </Button>
            )}
          </div>
        </div>

        {location ? (
          <section aria-labelledby="como-llegar" className="superficie flex flex-col gap-2 rounded-2xl p-4 sm:p-5">
            <h2 id="como-llegar" className="text-base font-semibold">
              {t("howToGet")}
            </h2>
            <p className="text-sm">
              {location.name}
              {location.address || location.city ? `, ${[location.address, location.city].filter(Boolean).join(", ")}` : ""}
            </p>
            <div className="flex flex-wrap gap-x-5 text-sm">
              {map ? (
                <a href={map} target="_blank" rel="noreferrer" className={ENLACE}>
                  <MapPinIcon aria-hidden className="size-4" />
                  {t("openMap")}
                </a>
              ) : null}
              {phone ? (
                <a href={telHref(phone)} className={ENLACE}>
                  <PhoneIcon aria-hidden className="size-4" />
                  {phone}
                </a>
              ) : null}
            </div>
          </section>
        ) : null}

        <div className="flex flex-col gap-1.5 text-[12.5px] text-muted-foreground">
          {active ? <p>{cancellationText(restaurant.cancellationFreeUntilHours, t)}</p> : null}
          {active ? <p>{t("changeHint")}</p> : null}
          {/* Recién hecha, el aviso de guardar el enlace se destaca: es la única forma de volver a ella. */}
          {active ? <p className={isNew ? "text-foreground" : undefined}>{t("saveLink")}</p> : null}
        </div>
      </div>

      <Dialog open={cancelOpen} onOpenChange={onCancelOpen}>
        <DialogContent
          showCloseButton={false}
          onOpenAutoFocus={(event) => {
            // Lo seguro primero: el foco cae en «mantenerla», no en cancelar.
            event.preventDefault()
            keepRef.current?.focus()
          }}
        >
          {/* Radix pisa el style del contenido: la marca va en un envoltorio que no cambia la maqueta. */}
          <div style={marca} className={`${styles.publica} contents`}>
            <DialogHeader>
              <DialogTitle>{t("cancelQuestion")}</DialogTitle>
              <DialogDescription>{t("cancelExplain", { date: formatLongDate(date, lang), time })}</DialogDescription>
            </DialogHeader>
            {lateCancel ? <p className="text-sm text-warning">{t("cancelLate")}</p> : null}
            {view.freeCancellationUntil !== null && !lateCancel ? (
              <p className="text-sm text-muted-foreground">
                {t("cancelFreeUntil", {
                  date: formatLongDate(wallOf(view.freeCancellationUntil, view.timezone).date, lang),
                  time: wallOf(view.freeCancellationUntil, view.timezone).time,
                })}
              </p>
            ) : null}
            {actionError ? <Notice tone="error" title={actionError.message} /> : null}
            <DialogFooter className="flex-col gap-2 sm:flex-col">
              <Button size="xl" variant="destructive" className="w-full" disabled={busy === "cancel"} onClick={() => onManage("cancel")}>
                <Ocupado busy={busy === "cancel"} />
                {busy === "cancel" ? t("cancelling") : t("yesCancel")}
              </Button>
              <Button ref={keepRef} size="xl" variant="outline" className="w-full" onClick={() => onCancelOpen(false)}>
                {t("keepBooking")}
              </Button>
            </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </PublicShell>
  )
}
