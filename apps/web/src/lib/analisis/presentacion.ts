import { formatMoney, type CallableOutput, type DerivedMetrics } from "@llenamos/core"

export const euros = (value: number | null) => value === null ? "Sin datos" : formatMoney(value)
export const porcentaje = (value: number | null) => value === null ? "Sin datos" : `${new Intl.NumberFormat("es", { maximumFractionDigits: 1 }).format(value / 100)} %`
export function cambio(value: { previous: number | null; deltaBp: number | null } | undefined) {
  if (value?.previous == null) return "Sin base anterior"
  if (value.deltaBp === null) return "Sin base porcentual"
  return `${value.deltaBp > 0 ? "+" : ""}${porcentaje(value.deltaBp)} respecto al anterior`
}
export const METRICAS: { key: keyof DerivedMetrics; label: string; definition: string; format: (v: number | null) => string }[] = [
  { key: "grossSalesCents", label: "Ventas brutas", definition: "Cuentas liquidadas tras ajustes, con IVA y sin propinas. Se cuentan el día local del cobro.", format: euros },
  { key: "netSalesCents", label: "Ventas netas", definition: "Ventas brutas sin IVA menos devoluciones sin IVA.", format: euros },
  { key: "guests", label: "Comensales", definition: "Comensales de las mesas cobradas. Para llevar no cuenta.", format: (v) => v === null ? "Sin datos" : String(v) },
  { key: "averageTicketCents", label: "Ticket medio", definition: "Ventas brutas divididas entre cuentas cobradas.", format: euros },
  { key: "averagePerGuestCents", label: "Gasto por comensal", definition: "Ventas brutas de mesas divididas entre sus comensales.", format: euros },
  { key: "occupancyBp", label: "Ocupación", definition: "Minutos de comensal sentado divididos entre plazas por minutos abiertos. Como máximo, 100 %.", format: porcentaje },
  { key: "noShowBp", label: "No presentados", definition: "Reservas no presentadas divididas entre confirmadas, sentadas, terminadas y no presentadas. Pendientes y canceladas no cuentan.", format: porcentaje },
  { key: "rotationBp", label: "Rotación", definition: "Comensales divididos entre plazas por días abiertos.", format: (v) => v === null ? "Sin datos" : `${new Intl.NumberFormat("es", { maximumFractionDigits: 2 }).format(v / 10_000)} vueltas` },
  { key: "revenuePerSeatHourCents", label: "Ingreso por plaza y hora", definition: "Ventas brutas de mesas divididas entre plazas por horas abiertas.", format: euros },
  { key: "refundCents", label: "Devoluciones", definition: "Devoluciones confirmadas en el día en que se hacen.", format: euros },
  { key: "discountCents", label: "Descuentos", definition: "Invitaciones más descuentos de promociones y canjes.", format: euros },
]
export type PanelDatos = CallableOutput<"panelAnalisis">

export function descargarCsv(data: CallableOutput<"exportarAnalisis">) {
  const url = URL.createObjectURL(new Blob([data.csv], { type: "text/csv;charset=utf-8" }))
  const link = document.createElement("a")
  link.href = url; link.download = data.filename.replace(/[/\\]/g, "_"); link.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
