"use client"

/**
 * «Otra fecha»: el patrón date picker de shadcn (Popover y Calendar de react-day-picker),
 * en el idioma de la página y limitado a los días que el restaurante deja reservar.
 * Las fechas van como texto AAAA-MM-DD, el día de calendario del local.
 */
import type { Language } from "@llenamos/core"
import { CalendarBlankIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { ca, enGB, es } from "react-day-picker/locale"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/cn"
import { formatLongDate } from "@/lib/publica/fechas"
import { useCloseOnHide } from "@/lib/open-state"
import { usePublic } from "./PublicContext"
import { useMarca } from "./PublicShell"

const LOCALES = { es, ca, en: enGB } as const satisfies Record<Language, unknown>

/** «2026-12-04» a un Date a medianoche local (lo que usa react-day-picker) y al revés. */
function toDate(day: string): Date {
  const [y, m, d] = day.split("-").map(Number)
  return new Date(y ?? 1970, (m ?? 1) - 1, d ?? 1)
}
function toDay(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function OtraFecha({
  value,
  first,
  last,
  highlighted,
  onChange,
}: {
  value: string
  first: string
  last: string
  /** El día elegido no está en la tira de días: el botón lo enseña marcado. */
  highlighted: boolean
  onChange: (day: string) => void
}) {
  const { t, lang } = usePublic()
  const marca = useMarca()
  const [open, setOpen] = useState(false)
  useCloseOnHide(() => setOpen(false))
  const selected = toDate(value)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="xl"
          className={cn("w-full justify-start font-normal", highlighted && "border-primary text-foreground")}
          aria-label={highlighted ? `${t("otherDate")}: ${formatLongDate(value, lang)}` : t("otherDate")}
        >
          <CalendarBlankIcon aria-hidden className="size-5" />
          {highlighted ? <span className="first-letter:uppercase">{formatLongDate(value, lang)}</span> : t("otherDate")}
        </Button>
      </PopoverTrigger>
      <PopoverContent collisionPadding={16} align="start" className="w-auto max-w-[calc(100vw-2rem)] max-h-(--radix-popover-content-available-height) overflow-y-auto rounded-2xl p-0 shadow-float">
        {/* Radix pisa el style del contenido: la marca va en un envoltorio que no cambia la maqueta. */}
        <div style={marca} className="contents">
          <Calendar
            mode="single"
            locale={LOCALES[lang]}
            weekStartsOn={1}
            selected={selected}
            defaultMonth={selected}
            startMonth={toDate(first)}
            endMonth={toDate(last)}
            disabled={[{ before: toDate(first) }, { after: toDate(last) }]}
            // Siete casillas de 48 px y el margen caben en un móvil de 390 px.
            className="[--cell-size:--spacing(12)]"
            classNames={{ day_button: "min-h-12 min-w-12 pointer-coarse:min-h-12 pointer-coarse:min-w-12" }}
            onSelect={(date) => {
              if (!date) return
              onChange(toDay(date))
              setOpen(false)
            }}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}
