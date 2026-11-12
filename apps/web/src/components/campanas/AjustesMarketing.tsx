"use client"

import { defaultMarketingSettings, MarketingSettingsSchema, type MarketingSettings } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { TextField } from "@/components/common/form-fields"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { useAjustesMarketing } from "@/lib/campanas/datos"
import { useOperacionMarketing } from "@/lib/campanas/useOperacion"
import { AVISO_WHATSAPP } from "@/lib/campanas/modelo"
import { ErrorLectura, MarcoCampanas, NavCampanas } from "./MarcoCampanas"

export function AjustesMarketingView() {
  return (
    <MarcoCampanas>
      <AjustesDatos />
    </MarcoCampanas>
  )
}
function AjustesDatos() {
  const { restaurant } = usePanel()
  const live = useAjustesMarketing(restaurant.id)
  return (
    <>
      <PageHeading
        title="Novedades con permiso y sin agobiar"
        eyebrow={restaurant.name}
        description="Un límite por cliente para todos los canales y una ventana de envío en la hora del restaurante."
      />
      <NavCampanas />
      {live.status === "error" ? (
        <ErrorLectura error={live.error} />
      ) : live.status === "loading" ? (
        <LoadingBlock label="Cargando ajustes" />
      ) : (
        <AjustesMarketing
          key={JSON.stringify(live.data)}
          inicial={live.data ?? defaultMarketingSettings(restaurant.name)}
          sinGuardar={live.data === null}
        />
      )}
    </>
  )
}
export function AjustesMarketing({
  inicial,
  sinGuardar = false,
  fixture = false,
}: {
  inicial: MarketingSettings
  sinGuardar?: boolean
  fixture?: boolean
}) {
  const { restaurant } = usePanel()
  const [d, setD] = useState(inicial)
  const op = useOperacionMarketing()
  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    const parsed = MarketingSettingsSchema.safeParse(d)
    if (!parsed.success) {
      op.fail(
        "Revisa los campos. El límite es de 1 a 8 mensajes, la separación de 24 a 720 horas y la hora de inicio debe ir antes del final.",
      )
      return
    }
    if (fixture) return
    const out = await op.run("guardarConfiguracionMarketing", { restaurantId: restaurant.id, settings: parsed.data })
    if (out) toast.success("Ajustes de marketing guardados")
  }
  return (
    <div className="space-y-5">
      {sinGuardar ? (
        <Notice title="Aún no hay ajustes guardados">
          Estos son los valores iniciales del contrato. Se guardarán cuando confirmes el formulario.
        </Notice>
      ) : null}
      <form onSubmit={guardar} className="superficie" noValidate>
        <fieldset disabled={op.busy || fixture} className="space-y-5 p-5">
          <legend className="sr-only">Ajustes de marketing</legend>
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField
              label="Nombre que firma los mensajes"
              value={d.senderName}
              maxLength={60}
              onChange={(e) => setD({ ...d, senderName: e.target.value })}
            />
            <TextField
              label="Máximo de mensajes en 30 días"
              type="number"
              min={1}
              max={8}
              value={d.maxPer30Days}
              onChange={(e) => setD({ ...d, maxPer30Days: Number(e.target.value) })}
              hint="Cuenta correo y WhatsApp juntos."
            />
            <TextField
              label="Horas entre dos mensajes"
              type="number"
              min={24}
              max={720}
              value={d.minHoursBetween}
              onChange={(e) => setD({ ...d, minHoursBetween: Number(e.target.value) })}
            />
            <div className="grid grid-cols-2 gap-3">
              <TextField
                label="Desde las"
                type="time"
                value={d.sendWindow.from}
                onChange={(e) => setD({ ...d, sendWindow: { ...d.sendWindow, from: e.target.value } })}
              />
              <TextField
                label="Hasta las"
                type="time"
                value={d.sendWindow.to}
                onChange={(e) => setD({ ...d, sendWindow: { ...d.sendWindow, to: e.target.value } })}
              />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            Horario de {restaurant.timezone}. Fuera de esta ventana, la cola espera al siguiente día. Importar una ficha de cliente o
            recibir una reserva no da permiso para marketing.
          </p>
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
          <Button type="submit" size="lg" disabled={op.busy || fixture}>
            {op.busy ? "Guardando…" : "Guardar ajustes"}
          </Button>
        </fieldset>
      </form>
      <Notice tone="warning" title="WhatsApp pendiente de configurar">
        {AVISO_WHATSAPP}
      </Notice>
      <Notice title="Envíos solo de prueba">
        En el emulador, el correo puede quedar capturado para revisarlo. Un mensaje capturado o sin proveedor no cuenta como enviado.
      </Notice>
    </div>
  )
}
