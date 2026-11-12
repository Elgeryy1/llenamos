"use client"

import { CampaignInputSchema, type CallableInput } from "@llenamos/core"
import { useState } from "react"
import { toast } from "sonner"
import { Notice } from "@/components/common/notice"
import { TextField, SelectField, TextareaField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { usePanel } from "@/components/panel/PanelContext"
import { type Campana, type Segmento } from "@/lib/campanas/datos"
import { AVISO_WHATSAPP } from "@/lib/campanas/modelo"
import { useOperacionMarketing } from "@/lib/campanas/useOperacion"

export function CampanaEditor({ actual, segmentos, onClose }: { actual: Campana | null; segmentos: Segmento[]; onClose: () => void }) {
  const { restaurant, locations } = usePanel()
  const [d, setD] = useState<CallableInput<"guardarCampana">["campaign"]>(() => ({
    name: actual?.name ?? "",
    segmentId: actual?.segmentId ?? segmentos[0]?.id ?? "",
    channel: actual?.channel ?? "email",
    content: actual?.content ?? { title: "", body: "", includeBookingLink: true },
    locationId: actual?.locationId ?? null,
  }))
  const op = useOperacionMarketing()
  async function guardar(e: React.FormEvent) {
    e.preventDefault()
    const parsed = CampaignInputSchema.safeParse(d)
    if (!parsed.success) {
      op.fail("Escribe el nombre, el título y el mensaje, y elige un segmento.")
      return
    }
    const out = await op.run("guardarCampana", {
      restaurantId: restaurant.id,
      campaignId: actual?.id ?? null,
      expectedRevision: actual?.revision ?? null,
      campaign: parsed.data,
    })
    if (out) {
      toast.success("Borrador guardado. Aún no se ha programado ningún envío.")
      onClose()
    }
  }
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="gap-0 overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-xl">
        <SheetHeader className="border-b">
          <SheetTitle>{actual ? "Editar borrador" : "Nueva campaña"}</SheetTitle>
          <SheetDescription>Guardar no envía nada. Después podrás simular el mensaje y el propietario podrá programarlo.</SheetDescription>
        </SheetHeader>
        <form noValidate onSubmit={guardar} className="space-y-5 p-5">
          <fieldset disabled={op.busy} className="space-y-5">
            <TextField label="Nombre interno" value={d.name} maxLength={80} onChange={(e) => setD({ ...d, name: e.target.value })} />
            <SelectField label="Segmento" value={d.segmentId} onChange={(e) => setD({ ...d, segmentId: e.target.value })}>
              {segmentos.map((s) => (
                <option value={s.id} key={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
            <SelectField label="Canal" value={d.channel} onChange={(e) => setD({ ...d, channel: e.target.value as typeof d.channel })}>
              <option value="email">Correo</option>
              <option value="whatsapp">WhatsApp</option>
            </SelectField>
            <SelectField
              label="Local del enlace de reservas"
              value={d.locationId ?? "primero"}
              onChange={(e) => setD({ ...d, locationId: e.target.value === "primero" ? null : e.target.value })}
            >
              <option value="primero">Primer local del restaurante</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Título del mensaje"
              maxLength={80}
              value={d.content.title}
              onChange={(e) => setD({ ...d, content: { ...d.content, title: e.target.value } })}
            />
            <TextareaField
              label="Texto del mensaje"
              rows={7}
              maxLength={1000}
              value={d.content.body}
              onChange={(e) => setD({ ...d, content: { ...d.content, body: e.target.value } })}
              hint={`${d.content.body.length} de 1000 caracteres. La firma y el enlace de baja los añade el servidor.`}
            />
            <label className="flex min-h-11 items-center gap-3 text-sm">
              <Checkbox
                checked={d.content.includeBookingLink}
                onCheckedChange={(value) => setD({ ...d, content: { ...d.content, includeBookingLink: value === true } })}
              />{" "}
              Añadir enlace para reservar y medir su origen
            </label>
          </fieldset>
          {d.channel === "whatsapp" ? (
            <Notice tone="warning" title="WhatsApp no está configurado">
              {AVISO_WHATSAPP}
            </Notice>
          ) : null}
          {op.error ? <Notice tone="error">{op.error}</Notice> : null}
          <div className="border-t pt-4">
            <Button type="submit" size="lg" disabled={op.busy}>
              {op.busy ? "Guardando…" : "Guardar borrador"}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  )
}
