"use client"

import { can, restaurantModules, LoyaltySettingsSchema, LANGUAGE_LABEL } from "@llenamos/core"
import { FichaFidelizacion } from "@/components/fidelizacion/FichaFidelizacion"
import { useDocumento } from "@/lib/fidelizacion/datos"
import { PhoneIcon } from "@phosphor-icons/react"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"
import { TextareaField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { CustomerBadges } from "@/components/common/customer-badges"
import { ESTADO_DE_STATUS, StatusDot } from "@/components/common/reservation-status"
import { GuestAvatar } from "@/components/reservas/Huesped"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { saveCustomerEdit, validateCustomerEdit } from "@/lib/data/clientes"
import { useCustomerReservations, type CustomerDoc } from "@/lib/data/reservas"
import { useCloseOnHide } from "@/lib/open-state"
import { euros, prettyPhone, shortDate, timeOf } from "@/lib/reservas/formato"
import { useMutation } from "@/lib/reservas/hooks"

/** Ficha de cliente: visitas, no presentados, cancelaciones, notas, alergias y etiquetas. */
export function CustomerSheet({
  customer,
  open,
  onOpenChange,
  timezone,
}: {
  customer: CustomerDoc
  open: boolean
  onOpenChange: (open: boolean) => void
  timezone: string
}) {
  useCloseOnHide(() => onOpenChange(false))
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 overflow-y-auto shadow-float duration-200 ease-(--ease-llenamos) data-[side=right]:w-full data-[side=right]:sm:max-w-lg sm:rounded-l-[14px] [&_[data-slot=sheet-close]]:size-11">
        {open ? <CustomerBody key={customer.id} customer={customer} timezone={timezone} onDone={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function CustomerBody({ customer: c, timezone, onDone }: { customer: CustomerDoc; timezone: string; onDone: () => void }) {
  const { restaurant, location, role, user } = usePanel()
  const modules = restaurantModules(restaurant)
  const loyalty = useDocumento(restaurant.id, "settings/loyalty", LoyaltySettingsSchema, modules.includes("loyalty") && can(role, "fidelizacion.ver"))
  const editable = can(role, "clientes.editar")
  const history = useCustomerReservations(restaurant.id, location?.id ?? null, c.id)
  const [notes, setNotes] = useState(c.notes)
  const [allergies, setAllergies] = useState(c.allergies)
  const [tags, setTags] = useState(c.tags.join(", "))
  const [errors, setErrors] = useState<Partial<Record<"notes" | "allergies" | "tags", string>>>({})
  const save = useMutation(async (value: Parameters<typeof saveCustomerEdit>[2]) => saveCustomerEdit(restaurant.id, c.id, value, user.uid))
  const dirty = notes !== c.notes || allergies !== c.allergies || tags !== c.tags.join(", ")

  async function submit(e: FormEvent) {
    e.preventDefault()
    const v = validateCustomerEdit({ notes, allergies, tags })
    if (!v.ok) return setErrors(v.errors)
    setErrors({})
    if (await save.run(v.value)) {
      toast.success(`Ficha de ${c.name} guardada`)
      onDone()
    }
  }

  return (
    <div className="flex min-h-full flex-col">
      <SheetHeader className="gap-3 border-b p-5 pr-14">
        <p className="text-xs text-muted-foreground">Ficha de cliente</p>
        <div className="flex min-w-0 items-center gap-3">
          <GuestAvatar name={c.name} size="lg" className="shrink-0" />
          <SheetTitle className="min-w-0 text-2xl font-semibold tracking-tight break-words">{c.name}</SheetTitle>
        </div>
        <SheetDescription className="sr-only">Contacto, visitas y preferencias de {c.name}.</SheetDescription>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
          <a href={`tel:${c.phone}`} className="cifra inline-flex min-h-11 items-center gap-2 rounded-lg text-soft-foreground hover:text-foreground"><PhoneIcon aria-hidden />{prettyPhone(c.phone)}</a>
          <span>{LANGUAGE_LABEL[c.language]}</span>
          {c.email ? <span className="w-full break-all">{c.email}</span> : null}
        </div>
        <CustomerBadges customer={c} />
      </SheetHeader>

      <div className="flex min-w-0 flex-1 flex-col gap-6 p-5">
        <dl className="superficie grid grid-cols-3 divide-x overflow-hidden text-center">
          <Stat label="Visitas" value={c.visits} />
          <Stat label="No vino" value={c.noShows} warn={c.noShows > 0} />
          <Stat label="Canceló" value={c.cancellations} />
        </dl>
        <p className="-mt-4 text-sm text-muted-foreground">
          {c.lastVisitAt ? `Última visita el ${shortDate(c.lastVisitAt, timezone)}.` : "Todavía no ha venido."} Las cifras las cuenta el sistema al cerrar cada reserva.
        </p>
        {c.spentCents !== undefined ? (
          <section className="superficie p-4" aria-label="Consumo registrado">
            <h2 className="text-sm text-muted-foreground">Consumo registrado</h2>
            <p className="cifra mt-1 text-3xl font-semibold">{euros(c.spentCents)}</p>
            <p className="mt-2 text-xs text-muted-foreground">Mesas cerradas y pedidos para llevar recogidos. No confirma un pago.</p>
          </section>
        ) : null}

        {editable ? (
          <form id="preferencias-cliente" onSubmit={submit} className="flex flex-col gap-4" aria-label="Preferencias del cliente">
            <div><h2 className="text-base font-semibold">Para recibirle bien</h2><p className="mt-1 text-xs text-muted-foreground">El equipo ve estas preferencias en sus reservas.</p></div>
            <TextField label="Alergias" value={allergies} onChange={(e) => setAllergies(e.target.value)} error={errors.allergies} hint="Se avisa en cada reserva suya." maxLength={500} />
            <TextField label="Etiquetas" value={tags} onChange={(e) => setTags(e.target.value)} error={errors.tags} hint="Separadas por comas: habitual, terraza, sin gluten." />
            <TextareaField label="Notas" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors.notes} maxLength={1000} rows={4} />
          </form>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <CustomerBadges customer={c} />
            <p className="whitespace-pre-line text-soft-foreground">{c.notes || "Sin notas."}</p>
          </div>
        )}

        <FichaFidelizacion restaurantId={restaurant.id} customerId={c.id} customerName={c.name} role={role} modules={modules} termsVersion={loyalty.status === "ready" ? loyalty.data?.termsVersion ?? null : null} timezone={timezone} locationId={location?.id} reservationId={history.status === "ready" ? history.data.find((reservation) => reservation.status === "seated")?.id ?? null : null} />

        <section className="flex flex-col gap-2" aria-label="Reservas">
          <h2 className="text-base font-semibold">Reservas en {location?.name ?? "este local"}</h2>
          {history.status === "ready" ? (
            history.data.length === 0 ? (
              <span className="text-sm text-muted-foreground">Ninguna en este local.</span>
            ) : (
              <ul className="superficie flex flex-col divide-y overflow-hidden">
                {history.data.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-3 text-sm">
                    <span className="cifra">
                      {shortDate(r.startAt, timezone)} {timeOf(r.startAt, timezone)}
                    </span>
                    <span className="cifra text-muted-foreground">{r.partySize} pers.</span>
                    <StatusDot estado={ESTADO_DE_STATUS[r.status]} />
                  </li>
                ))}
              </ul>
            )
          ) : history.status === "loading" ? (
            <span className="text-sm text-muted-foreground">Cargando…</span>
          ) : (
            <span className="text-sm text-muted-foreground">No se han podido cargar sus reservas.</span>
          )}
        </section>

        {save.error ? (
          <Notice tone="error" title="No se ha podido guardar la ficha" detail={save.error.code}>
            {save.error.message}
          </Notice>
        ) : null}
      </div>

      {editable ? (
        <SheetFooter className="sticky bottom-0 border-t bg-popover p-5">
          <Button type="submit" form="preferencias-cliente" size="lg" className="h-12 shadow-soft" disabled={!dirty || save.pending}>
            {save.pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
            {save.pending ? "Guardando…" : "Guardar ficha"}
          </Button>
        </SheetFooter>
      ) : null}
    </div>
  )
}

function Stat({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="bg-card px-2 py-4">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={`cifra mt-1 text-3xl font-semibold ${warn ? "text-warning" : ""}`}>{value}</dd>
    </div>
  )
}
