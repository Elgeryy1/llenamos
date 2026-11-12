"use client"

import { CalendarBlankIcon } from "@phosphor-icons/react"
import { useState, type AriaAttributes, type ComponentProps } from "react"
import { es } from "react-day-picker/locale"
import type { Matcher } from "react-day-picker"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/cn"
import { useCloseOnHide } from "@/lib/open-state"
import { dateToFecha, fechaToDate } from "@/lib/reservas/formato"

const largo = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long" })
const conAno = new Intl.DateTimeFormat("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
const corto = new Intl.DateTimeFormat("es-ES", { weekday: "short", day: "numeric", month: "short" })

/** «lun 9 nov», para cuando no cabe la fecha larga. */
export function formatoDiaCorto(date: Date): string {
  return corto.format(date).replace(/[.,]/g, "")
}

/** «lunes 9 de noviembre», como en la cabecera de reservas. */
export function formatoDia(date: Date, showYear = false): string {
  return (showYear ? conAno : largo).format(date).replace(",", "")
}

/**
 * Selector de un día: botón con la fecha escrita y calendario en castellano (lunes
 * primero) en un Popover. Es el patrón «date picker» de shadcn (Popover + Calendar,
 * react-day-picker). Para fechas en la hora del local, convierte tú el día elegido.
 */
export function DatePicker({
  value,
  onChange,
  label = "Elegir día",
  disabled,
  placeholder = "Elige un día",
  className,
  shortOnMobile = false,
  id,
  onClear,
  showYear = false,
  ...aria
}: {
  value: Date | undefined
  onChange: (date: Date) => void
  /** Nombre accesible del botón. */
  label?: string
  /** Días que no se pueden elegir (`{ before: hoy }`, cerrados…). */
  disabled?: Matcher | Matcher[]
  placeholder?: string
  className?: string
  /** En el móvil, la fecha corta («lun 9 nov») y sin icono, para que quepa junto al turno. */
  shortOnMobile?: boolean
  id?: string
  onClear?: () => void
  showYear?: boolean
} & Pick<AriaAttributes, "aria-invalid" | "aria-describedby">) {
  const [open, setOpen] = useState(false)
  useCloseOnHide(() => setOpen(false))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          id={id}
          {...aria}
          aria-label={value ? `${label}: ${formatoDia(value, showYear)}` : label}
          className={cn("justify-start gap-2 font-normal", !value && "text-muted-foreground", className)}
        >
          <CalendarBlankIcon aria-hidden className={shortOnMobile ? "max-sm:hidden" : undefined} />
          {value ? (
            shortOnMobile ? (
              <>
                <span className="sm:hidden">{formatoDiaCorto(value)}</span>
                <span className="max-sm:hidden">{formatoDia(value, showYear)}</span>
              </>
            ) : (
              formatoDia(value, showYear)
            )
          ) : (
            placeholder
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent collisionPadding={16} className="w-auto max-w-[calc(100vw-2rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto p-0" align="start">
        <Calendar
          mode="single"
          locale={es}
          weekStartsOn={1}
          selected={value}
          defaultMonth={value}
          disabled={disabled}
          className="pointer-coarse:[--cell-size:--spacing(11)]"
          onSelect={(d) => {
            if (!d) return
            onChange(d)
            setOpen(false)
          }}
        />
        {onClear ? (
          <div className="border-t p-2">
            <Button type="button" variant="ghost" className="w-full" onClick={() => { onClear(); setOpen(false) }}>
              Borrar fecha
            </Button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  )
}

/** Fecha de calendario del local, en AAAA-MM-DD, sin convertirla a un instante UTC. */
export function DateInput({ value, onChange, min, clearable = true, ...props }: Omit<ComponentProps<typeof DatePicker>, "value" | "onChange" | "disabled" | "onClear"> & {
  value: string
  onChange: (value: string) => void
  min?: string
  clearable?: boolean
}) {
  return (
    <DatePicker
      showYear
      {...props}
      value={value ? fechaToDate(value) : undefined}
      onChange={(date) => onChange(dateToFecha(date))}
      disabled={min ? { before: fechaToDate(min) } : undefined}
      onClear={clearable ? () => onChange("") : undefined}
    />
  )
}
