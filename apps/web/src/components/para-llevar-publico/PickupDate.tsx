"use client"
import { useState } from "react"
import { ca, enGB, es } from "react-day-picker/locale"
import { Calendar } from "@/components/ui/calendar"
import { Button } from "@/components/ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { usePublic } from "@/components/publica/PublicContext"
import { useMarca } from "@/components/publica/PublicShell"
import { formatLongDate } from "@/lib/publica/fechas"
import { fechaToDate, dateToFecha } from "@/lib/reservas/formato"
import { publicText } from "@/lib/mesa-publica/textos"
import { useCloseOnHide } from "@/lib/open-state"

export function PickupDate({
  value,
  min,
  onChange,
}: {
  value: string
  min: string
  onChange: (value: string) => void
}) {
  const { lang } = usePublic()
  const marca = useMarca()
  const [open, setOpen] = useState(false)
  useCloseOnHide(() => setOpen(false))
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{publicText(lang, "date")}</p>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            className="h-12 w-full justify-start"
            variant="outline"
            aria-label={`${publicText(lang, "date")}: ${formatLongDate(value, lang)}`}
          >
            {formatLongDate(value, lang)}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto max-w-[calc(100vw-2rem)] p-0" align="start">
          <div style={marca}>
            <Calendar
              mode="single"
              locale={{ es, ca, en: enGB }[lang]}
              weekStartsOn={1}
              selected={fechaToDate(value)}
              defaultMonth={fechaToDate(value)}
              disabled={{ before: fechaToDate(min) }}
              className="[--cell-size:--spacing(12)]"
              onSelect={(date) => {
                if (date) {
                  onChange(dateToFecha(date))
                  setOpen(false)
                }
              }}
            />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  )
}
