"use client"

import { CrearReservaInputSchema, LANGUAGE_LABEL, LANGUAGES, type CallableInput, type ConfiguracionReservas, type Language } from "@llenamos/core"
import { useState, type FormEvent } from "react"
import { toast } from "sonner"
import { DatePicker } from "@/components/common/date-picker"
import { SelectField, TextareaField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { SegmentedControl } from "@/components/common/segmented-control"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { llamarCore } from "@/lib/data/callables"
import type { TableDoc } from "@/lib/data/parse"
import { useDayReservations } from "@/lib/data/reservas"
import { useCloseOnHide } from "@/lib/open-state"
import { staffAvailability, walkInTime } from "@/lib/reservas/disponibilidad"
import { dateToFecha, fechaToDate, longDate } from "@/lib/reservas/formato"
import { useMutation, useNow } from "@/lib/reservas/hooks"
import { useProposals } from "@/lib/reservas/useProposals"
import { SlotSelect } from "./SlotSelect"
import { TableProposalPicker } from "./TableProposals"
import { TimeSelectField } from "@/components/common/time-select-field"

type Source = "phone" | "walk_in"
const FIELDS = ["guestName", "phone", "email", "partySize", "time", "notes"] as const
type FieldName = (typeof FIELDS)[number]

/** Nueva reserva tomada por el personal: por teléfono o de alguien que entra al local. */
export function NewReservationSheet({
  open,
  onOpenChange,
  defaultDate,
  config,
  tables,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultDate: string
  config: ConfiguracionReservas
  tables: readonly TableDoc[]
  onCreated: (reservationId: string, date: string) => void
}) {
  useCloseOnHide(() => onOpenChange(false))
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-md">
        {open ? <NewReservationForm defaultDate={defaultDate} config={config} tables={tables} onCreated={onCreated} onCancel={() => onOpenChange(false)} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function NewReservationForm({
  defaultDate,
  config,
  tables,
  onCreated,
  onCancel,
}: {
  defaultDate: string
  config: ConfiguracionReservas
  tables: readonly TableDoc[]
  onCreated: (reservationId: string, date: string) => void
  onCancel: () => void
}) {
  const { restaurant, location } = usePanel()
  const lid = location?.id ?? ""
  const now = useNow()
  const tz = config.zonaHoraria
  const [source, setSource] = useState<Source>("phone")
  const [date, setDate] = useState(defaultDate)
  const [time, setTime] = useState("")
  const [size, setSize] = useState("2")
  const [guestName, setGuestName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [language, setLanguage] = useState<Language>("es")
  const [notes, setNotes] = useState("")
  const [pendingConfirm, setPendingConfirm] = useState(false)
  const [seatNow, setSeatNow] = useState(true)
  const [tableIds, setTableIds] = useState<string[] | null>(null)
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({})

  const walkIn = walkInTime(now, tz)
  const effectiveDate = source === "walk_in" ? walkIn.date : date
  const effectiveTime = source === "walk_in" && time === "" ? walkIn.time : time
  const partySize = Number.parseInt(size, 10)
  const validSize = Number.isInteger(partySize) && partySize >= 1 && partySize <= 200

  const day = useDayReservations(restaurant.id, lid, effectiveDate, config)
  const availability =
    day.status === "ready" && validSize ? staffAvailability({ config, date: effectiveDate, partySize, tables, reservations: day.data, now }) : null
  const proposals = useProposals(
    effectiveTime && validSize ? { restaurantId: restaurant.id, locationId: lid, date: effectiveDate, time: effectiveTime, partySize, limit: 4 } : null,
  )

  const create = useMutation(async (input: CallableInput<"crearReserva">) => {
    const out = await llamarCore("crearReserva", input)
    toast.success(`Reserva de ${input.guestName} guardada · ref. ${out.reference}`)
    onCreated(out.reservationId, effectiveDate)
  })

  async function submit(e: FormEvent) {
    e.preventDefault()
    const input = {
      restaurantId: restaurant.id,
      locationId: lid,
      date: effectiveDate,
      time: effectiveTime,
      partySize: validSize ? partySize : Number.NaN,
      guestName,
      phone,
      email,
      language,
      source,
      status: source === "walk_in" ? (seatNow ? "seated" : "confirmed") : pendingConfirm ? "pending" : "confirmed",
      notes,
      tableIds: tableIds ?? [],
    } as const
    const parsed = CrearReservaInputSchema.safeParse(input)
    if (!parsed.success) {
      const next: Partial<Record<FieldName, string>> = {}
      for (const issue of parsed.error.issues) {
        const k = issue.path[0]
        if (typeof k === "string" && (FIELDS as readonly string[]).includes(k) && !next[k as FieldName]) next[k as FieldName] = issue.message
      }
      if (!effectiveTime) next.time = "Elige una hora."
      setErrors(next)
      return
    }
    setErrors({})
    await create.run(input)
  }

  return (
    <form onSubmit={submit} className="flex min-h-full flex-col" noValidate>
      <SheetHeader className="gap-1 border-b pb-4">
        <SheetTitle className="text-xl">Nueva reserva</SheetTitle>
        <SheetDescription>
          Como personal puedes saltarte la antelación y el tamaño de grupo de la web. El servidor comprueba que la mesa y la hora sigan libres.
        </SheetDescription>
      </SheetHeader>

      <div className="flex flex-1 flex-col gap-5 p-4">
        <SegmentedControl
          label="Cómo llega la reserva"
          value={source}
          onValueChange={(v) => {
            setSource(v)
            setTime("")
            setTableIds(null)
          }}
          options={[
            { value: "phone", label: "Por teléfono" },
            { value: "walk_in", label: "Entra ahora" },
          ]}
          className="self-start"
        />

        {source === "phone" ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Día</span>
            <DatePicker
              value={fechaToDate(date)}
              onChange={(d) => {
                setDate(dateToFecha(d))
                setTime("")
                setTableIds(null)
              }}
              label="Día de la reserva"
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            Hoy, {longDate(walkIn.date)}, a las <span className="cifra">{effectiveTime}</span>.
          </p>
        )}

        <div className="grid grid-cols-[6rem_minmax(0,1fr)] gap-3">
          <TextField
            label="Personas"
            type="number"
            inputMode="numeric"
            min={1}
            max={200}
            value={size}
            onChange={(e) => {
              setSize(e.target.value)
              setTableIds(null)
            }}
            error={errors.partySize ?? (validSize ? null : "Escribe cuántas vienen.")}
          />
          {source === "phone" ? (
            <SlotSelect
              availability={availability}
              value={time}
              onChange={(t) => {
                setTime(t)
                setTableIds(null)
              }}
              error={errors.time}
            />
          ) : (
            <TimeSelectField label="Hora" value={effectiveTime} onChange={setTime} error={errors.time} />
          )}
        </div>

        <TextField label="Nombre" autoComplete="off" value={guestName} onChange={(e) => setGuestName(e.target.value)} error={errors.guestName} />
        <TextField
          label="Teléfono"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          error={errors.phone}
          hint="Sin prefijo se entiende +34. Sirve para su ficha y los avisos por WhatsApp."
        />
        <TextField label="Correo (opcional)" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email} />
        <SelectField label="Idioma de los avisos" value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {LANGUAGES.map((l) => (
            <option key={l} value={l}>
              {LANGUAGE_LABEL[l]}
            </option>
          ))}
        </SelectField>
        <TextareaField label="Notas del equipo" value={notes} onChange={(e) => setNotes(e.target.value)} error={errors.notes} maxLength={500} rows={2} />

        {source === "phone" ? (
          <Field orientation="horizontal">
            <Checkbox id="nueva-pendiente" checked={pendingConfirm} onCheckedChange={(v) => setPendingConfirm(v === true)} />
            <FieldLabel htmlFor="nueva-pendiente" className="font-normal">
              Dejarla pendiente de confirmar
            </FieldLabel>
          </Field>
        ) : (
          <Field orientation="horizontal">
            <Checkbox id="nueva-sentar" checked={seatNow} onCheckedChange={(v) => setSeatNow(v === true)} />
            <FieldLabel htmlFor="nueva-sentar" className="font-normal">
              Sentarla ya
            </FieldLabel>
          </Field>
        )}

        <section className="flex flex-col gap-2" aria-label="Mesa">
          <span className="text-sm font-medium">Mesa</span>
          {proposals.status === "idle" ? (
            <p className="text-sm text-muted-foreground">Elige hora y personas para ver las mesas libres.</p>
          ) : (
            <>
              <TableProposalPicker state={proposals} selected={tableIds} onSelect={setTableIds} name="nueva-mesa" />
              {tableIds ? (
                <Button type="button" variant="ghost" size="sm" className="self-start" onClick={() => setTableIds(null)}>
                  Guardar sin mesa (se apunta la sugerida)
                </Button>
              ) : proposals.status === "ready" && proposals.data.proposals.length > 0 ? (
                <p className="text-sm text-muted-foreground">Si no eliges ninguna, se guarda sin mesa y se apunta la sugerida.</p>
              ) : null}
            </>
          )}
        </section>

        {create.error ? (
          <Notice tone="error" title="No se ha podido guardar la reserva" detail={create.error.code}>
            {create.error.message}
          </Notice>
        ) : null}
      </div>

      <SheetFooter className="sticky bottom-0 flex-row gap-2 border-t bg-popover">
        <Button type="button" variant="outline" size="lg" onClick={onCancel} disabled={create.pending}>
          Cancelar
        </Button>
        <Button type="submit" size="lg" className="flex-1" disabled={create.pending}>
          {create.pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
          {create.pending ? "Guardando…" : source === "walk_in" && seatNow ? "Guardar y sentar" : "Guardar reserva"}
        </Button>
      </SheetFooter>
    </form>
  )
}
