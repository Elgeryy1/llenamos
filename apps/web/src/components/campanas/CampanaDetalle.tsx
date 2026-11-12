"use client"

import type { CallableOutput, MarketingSettings } from "@llenamos/core"
import { useRef, useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { TextField } from "@/components/common/form-fields"
import { SummaryStrip } from "@/components/common/summary-strip"
import { SummaryList } from "@/components/common/summary-list"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { usePanel } from "@/components/panel/PanelContext"
import { llamarMarketing, errorMarketing } from "@/lib/campanas/api"
import type { Campana } from "@/lib/campanas/datos"
import { AVISO_WHATSAPP, ESTADO_CAMPANA, eurosMarketing, fechaMarketing, puedeLanzar } from "@/lib/campanas/modelo"
import { useOperacionMarketing } from "@/lib/campanas/useOperacion"
import { Audiencia } from "./Audiencia"

export function CampanaDetalle({
  actual,
  onClose,
  onEdit,
  fixture = false,
  fixtureSimulation,
  fixtureReport,
  settings,
}: {
  actual: Campana
  onClose: () => void
  onEdit: () => void
  fixture?: boolean
  settings?: MarketingSettings | null
  fixtureSimulation?: CallableOutput<"simularCampana">
  fixtureReport?: CallableOutput<"informeCampana">
}) {
  const { restaurant, role } = usePanel()
  const op = useOperacionMarketing()
  const [simulation, setSimulation] = useState<{ revision: number; data: CallableOutput<"simularCampana"> } | null>(
    fixtureSimulation ? { revision: actual.revision, data: fixtureSimulation } : null,
  )
  const [report, setReport] = useState(fixtureReport ?? null)
  const [loading, setLoading] = useState(false)
  const reading = useRef(false)
  const [confirmar, setConfirmar] = useState<"launch" | "cancel" | null>(null)
  const [revisionConfirmada, setRevisionConfirmada] = useState<number | null>(null)
  const [reason, setReason] = useState("")
  const [schedule, setSchedule] = useState("")
  const [revisionResultado, setRevisionResultado] = useState<number | null>(null)
  const cambioPendiente = revisionResultado !== null && actual.revision < revisionResultado
  const simulationActual = simulation?.revision === actual.revision ? simulation.data : null
  const input = { restaurantId: restaurant.id, campaignId: actual.id }
  async function leer(tipo: "simulate" | "report") {
    if (fixture || reading.current) return
    reading.current = true
    setLoading(true)
    op.fail(null)
    try {
      if (tipo === "simulate") setSimulation({ revision: actual.revision, data: await llamarMarketing("simularCampana", input) })
      else setReport(await llamarMarketing("informeCampana", input))
    } catch (error) {
      op.fail(errorMarketing(error))
    } finally {
      reading.current = false
      setLoading(false)
    }
  }
  async function confirmarAccion() {
    if (fixture || (confirmar === "launch" && !puedeLanzar(role))) return
    if (revisionConfirmada !== actual.revision || (confirmar === "launch" && !simulationActual)) {
      op.fail("La campaña ha cambiado. Cierra esta confirmación y vuelve a simular la revisión actual.")
      return
    }
    if (confirmar === "launch") {
      const at = schedule.trim() ? Date.parse(schedule) : null
      if (at !== null && (!Number.isFinite(at) || at <= Date.now() || !/(Z|[+-]\d{2}:\d{2})$/.test(schedule))) {
        op.fail("Escribe una fecha futura con su zona horaria, por ejemplo 2026-12-01T10:00:00+01:00, o deja el campo vacío.")
        return
      }
      const out = await op.run("lanzarCampana", { ...input, expectedRevision: actual.revision, at })
      if (out) {
        setRevisionResultado(out.revision)
        setSimulation(null)
        setConfirmar(null)
        toast.success(`Campaña programada para ${fechaMarketing(out.scheduledAt, restaurant.timezone)}. Revisa las entregas en el informe.`)
      }
    } else {
      if (!reason.trim()) {
        op.fail("Escribe el motivo de la cancelación.")
        return
      }
      const out = await op.run("cancelarCampana", { ...input, expectedRevision: actual.revision, reason: reason.trim() })
      if (out) {
        setRevisionResultado(out.revision)
        setSimulation(null)
        setConfirmar(null)
        toast.success(`Campaña cancelada. ${out.cancelledMessages} mensajes cancelados.`)
      }
    }
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b">
          <SheetTitle className="pr-8 text-xl">{actual.name}</SheetTitle>
          <SheetDescription>
            {ESTADO_CAMPANA[actual.status]} · {actual.channel === "email" ? "Correo" : "WhatsApp"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-5 p-5">
          {actual.channel === "whatsapp" ? (
            <Notice tone="warning" title="WhatsApp no saldrá">
              {AVISO_WHATSAPP}
            </Notice>
          ) : (
            <Notice title="Envíos locales de prueba">En el emulador, los mensajes quedan capturados. No se envía correo real.</Notice>
          )}
          <Notice title="Ventana de envío">
            {settings ? (
              <>
                De {settings.sendWindow.from} a {settings.sendWindow.to} · {restaurant.timezone}. Máximo {settings.maxPer30Days} mensajes en
                30 días y al menos {settings.minHoursBetween} horas entre dos mensajes, sumando los canales.
              </>
            ) : (
              "No hay ajustes de marketing guardados. Revisa Ajustes antes de programar la campaña."
            )}
          </Notice>
          <SummaryList
            items={[
              { label: "Estado", value: ESTADO_CAMPANA[actual.status] },
              {
                label: "Programada para",
                value: actual.scheduledAt ? fechaMarketing(actual.scheduledAt, restaurant.timezone) : "Aún sin programar",
              },
            ]}
          />
          <section className="superficie p-5">
            <h3 className="font-semibold">{actual.content.title}</h3>
            <p className="mt-3 whitespace-pre-wrap break-words text-sm text-soft-foreground">{actual.content.body}</p>
            <p className="mt-4 text-xs text-muted-foreground">
              Texto del borrador. El mensaje final, con su firma y baja, aparece al simular.
            </p>
          </section>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" disabled={loading || op.busy} onClick={() => leer("simulate")}>
              Simular campaña
            </Button>
            <Button variant="outline" disabled={loading || op.busy} onClick={() => leer("report")}>
              Actualizar informe
            </Button>
            {actual.status === "draft" ? (
              <Button variant="outline" disabled={fixture || op.busy} onClick={onEdit}>
                Editar borrador
              </Button>
            ) : null}
          </div>
          {loading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Consultando al servidor…
            </p>
          ) : null}
          {simulationActual ? (
            <>
              <h3 className="text-lg font-semibold">Antes de programar</h3>
              <Audiencia data={simulationActual} />
              <section className="superficie p-5">
                <p className="mb-3 text-xs text-muted-foreground">Vista del mensaje de muestra</p>
                {simulationActual.preview.subject ? <h4 className="mb-3 font-semibold">{simulationActual.preview.subject}</h4> : null}
                <p className="whitespace-pre-wrap break-words text-sm text-soft-foreground">{simulationActual.preview.body}</p>
              </section>
              <Notice title="Primer envío dentro de la ventana">
                {fechaMarketing(simulationActual.firstSendAt, restaurant.timezone)} · {restaurant.timezone}. El servidor vuelve a validar la
                audiencia al preparar la cola.
              </Notice>
            </>
          ) : null}
          {report ? <InformeCampana data={report} /> : null}
          {cambioPendiente ? <Notice>Esperando a que se actualice la campaña en directo.</Notice> : null}
          {!puedeLanzar(role) ? (
            <p className="text-sm text-muted-foreground">El propietario es quien puede programar esta campaña.</p>
          ) : null}
          <div className="flex flex-wrap gap-3 border-t pt-4">
            {puedeLanzar(role) && actual.status === "draft" ? (
              <Button
                size="lg"
                disabled={fixture || op.busy || cambioPendiente || !simulationActual}
                onClick={() => {
                  setRevisionConfirmada(actual.revision)
                  setConfirmar("launch")
                }}
              >
                Lanzar campaña
              </Button>
            ) : null}
            {["draft", "scheduled", "sending"].includes(actual.status) ? (
              <Button
                variant="outline"
                disabled={fixture || op.busy || cambioPendiente}
                onClick={() => {
                  setRevisionConfirmada(actual.revision)
                  setConfirmar("cancel")
                }}
              >
                Cancelar campaña
              </Button>
            ) : null}
          </div>
          {actual.status === "draft" && puedeLanzar(role) && !simulationActual ? (
            <p className="text-xs text-muted-foreground">Simula la revisión actual antes de lanzar.</p>
          ) : null}
          {confirmar && (confirmar !== "launch" || puedeLanzar(role)) ? (
            <section className="superficie space-y-4 p-5" aria-label="Confirmar acción">
              <h3 className="font-semibold">
                {confirmar === "launch" ? "Revisa y programa la campaña" : "Cancelar lo que aún no se ha enviado"}
              </h3>
              {confirmar === "launch" ? (
                <>
                  <p className="text-sm text-muted-foreground">
                    Se programa la preparación de la cola. Esta acción puede tener coste con un proveedor real. La ventana del restaurante y
                    el consentimiento siguen siendo obligatorios.
                  </p>
                  <TextField
                    label="Fecha y hora con zona (opcional)"
                    value={schedule}
                    onChange={(e) => setSchedule(e.target.value)}
                    placeholder="2026-12-01T10:00:00+01:00"
                    hint="Vacío programa el primer hueco permitido. Incluye siempre el desplazamiento de la zona horaria."
                  />
                </>
              ) : (
                <TextField label="Motivo de cancelación" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
              )}
              <div className="flex flex-wrap gap-2">
                <Button disabled={op.busy} variant={confirmar === "cancel" ? "destructive" : "default"} onClick={confirmarAccion}>
                  {op.busy ? "Confirmando…" : confirmar === "launch" ? "Confirmar programación" : "Confirmar cancelación"}
                </Button>
                <Button variant="outline" disabled={op.busy} onClick={() => setConfirmar(null)}>
                  Volver
                </Button>
              </div>
            </section>
          ) : null}
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}

export function InformeCampana({ data }: { data: CallableOutput<"informeCampana"> }) {
  return (
    <section className="space-y-4" aria-label="Informe de la campaña">
      <h3 className="text-lg font-semibold">Lo que trajo esta campaña</h3>
      <SummaryStrip
        label="Reservas y ventas atribuidas"
        items={[
          { label: "Reservas", value: data.reservations },
          { label: "Comensales", value: data.covers },
          { label: "Ventas cobradas", value: <span className="text-2xl sm:text-3xl">{eurosMarketing(data.salesCents)}</span> },
        ]}
      />
      <SummaryList
        items={[
          { label: "Presentados", value: data.seated },
          { label: "Bajas", value: data.unsubscribed },
          { label: "Audiencia", value: data.audience },
          { label: "En cola", value: data.queued },
          { label: "Enviados", value: data.sent },
          { label: "Capturados en pruebas", value: data.captured },
          { label: "Sin proveedor", value: data.notConfigured },
          { label: "Fallidos", value: data.failed },
          { label: "Cancelados", value: data.cancelled },
        ]}
      />
      <Audiencia
        data={{
          audience: data.audience,
          recipients: data.queued + data.sent + data.captured + data.notConfigured + data.failed + data.cancelled,
          excluded: data.excluded,
        }}
      />
      <p className="text-xs text-muted-foreground">
        Se atribuyen las reservas con el enlace de esta campaña y las ventas cobradas de sus mesas, con IVA. Capturado significa prueba
        local, nunca entrega real.
      </p>
    </section>
  )
}
