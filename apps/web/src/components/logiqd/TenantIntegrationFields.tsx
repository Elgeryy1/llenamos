"use client"

import { TextField } from "@/components/common/form-fields"
import type { CallableInput } from "@llenamos/core"

export type TenantIntegrations = NonNullable<CallableInput<"altaRestauranteLogiqd">["integrations"]>
export type IntegrationProvider = "stripe" | "whatsapp" | "email" | "fiscal" | "repite"
export type IntegrationStatuses = Partial<Record<IntegrationProvider, { configured: boolean; status: "configured" | "not_configured" | "adapter_pending" }>>

const groups: { provider: IntegrationProvider; label: string; fields: { key: string; label: string; secret?: boolean }[] }[] = [
  { provider: "stripe", label: "Stripe", fields: [
    { key: "secretKey", label: "Clave secreta de Stripe", secret: true },
    { key: "webhookSecret", label: "Firma del webhook de señales", secret: true },
    { key: "mobileWebhookSecret", label: "Firma del webhook de pago móvil", secret: true },
    { key: "accountId", label: "Identificador de cuenta Stripe" },
  ] },
  { provider: "whatsapp", label: "WhatsApp", fields: [
    { key: "token", label: "Token de WhatsApp", secret: true },
    { key: "phoneNumberId", label: "Identificador de teléfono de WhatsApp" },
    { key: "appSecret", label: "Secreto de la aplicación de WhatsApp", secret: true },
    { key: "verifyToken", label: "Token de verificación de WhatsApp", secret: true },
    { key: "templateTakeawayAccepted", label: "Plantilla de recogida aceptada" },
    { key: "templateTakeawayReady", label: "Plantilla de recogida lista" },
  ] },
  { provider: "email", label: "Correo", fields: [
    { key: "apiKey", label: "API de correo (Resend)", secret: true },
    { key: "from", label: "Remitente de correo verificado", },
  ] },
  { provider: "fiscal", label: "Verifactu", fields: [
    { key: "provider", label: "Nombre del proveedor de Verifactu" },
    { key: "apiKey", label: "API del proveedor de Verifactu", secret: true },
  ] },
  { provider: "repite", label: "Repite", fields: [
    { key: "apiKey", label: "API de Repite", secret: true },
    { key: "merchantId", label: "Identificador del comercio en Repite" },
  ] },
]

/** Solo envía cambios escritos ahora. Los campos vacíos nunca borran una clave existente. */
export function integrationChanges(values: TenantIntegrations, removed: IntegrationProvider[]) {
  const integrations: TenantIntegrations = {}
  for (const { provider } of groups) {
    if (removed.includes(provider)) continue
    const fields = Object.fromEntries(Object.entries(values[provider] ?? {}).filter(([, value]) => typeof value === "string" && value.trim()).map(([key, value]) => [key, value.trim()]))
    if (Object.keys(fields).length) integrations[provider] = fields
  }
  return { ...(Object.keys(integrations).length ? { integrations } : {}), ...(removed.length ? { removeIntegrations: removed } : {}) }
}

export function TenantIntegrationFields({ values, onChange, statuses, removed, onRemove, disabled }: {
  values: TenantIntegrations; onChange: (values: TenantIntegrations) => void
  statuses?: IntegrationStatuses; removed: IntegrationProvider[]; onRemove: (providers: IntegrationProvider[]) => void; disabled: boolean
}) {
  return <section className="space-y-3 rounded-xl border p-4" aria-label="Integraciones opcionales">
    <div><h3 className="font-semibold">APIs e integraciones opcionales</h3><p className="mt-1 text-sm text-muted-foreground">Puedes dejarlo todo en blanco y configurarlo más adelante. Las funciones que necesiten una API quedarán pendientes de configurar.</p></div>
    {statuses ? <p className="text-sm text-muted-foreground">Por seguridad las claves guardadas no se muestran. Dejar un campo vacío conserva su valor; escribe solo lo que quieras cambiar.</p> : null}
    {groups.map(({ provider, label, fields }) => {
      const status = statuses?.[provider], removing = removed.includes(provider)
      const state = removing ? "Se eliminará al guardar" : status?.status === "adapter_pending" ? "Credenciales guardadas; integración pendiente" : status?.configured ? "Configurada" : "Sin configurar"
      return <details key={provider} className="rounded-lg border px-3">
        <summary className="min-h-11 cursor-pointer py-3 text-sm font-medium">{label} <span className="font-normal text-muted-foreground">· {state}</span></summary>
        <fieldset className="space-y-3 pb-4" disabled={disabled || removing}>
          <legend className="sr-only">Configuración de {label}</legend>
          {provider === "fiscal" || provider === "repite" ? <p className="text-xs text-muted-foreground">Guardar una clave no activa el servicio. La conexión con el proveedor debe estar disponible y comprobada antes de usarlo.</p> : null}
          {fields.map(({ key, label: fieldLabel, secret }) => <TextField key={key} label={fieldLabel} type={secret ? "password" : "text"} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={4096} value={(values[provider] as Record<string, string> | undefined)?.[key] ?? ""} onChange={event => onChange({ ...values, [provider]: { ...values[provider], [key]: event.target.value } })} />)}
        </fieldset>
        {statuses ? <label className="mb-4 flex min-h-11 cursor-pointer items-center gap-2 text-sm"><input type="checkbox" checked={removing} disabled={disabled} onChange={event => onRemove(event.target.checked ? [...removed, provider] : removed.filter(value => value !== provider))} />Eliminar las credenciales de {label} al guardar</label> : null}
      </details>
    })}
  </section>
}
