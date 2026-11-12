"use client"

import type { PublicMarketingOptIn } from "@llenamos/core"
import { useEffect, useId } from "react"
import { Checkbox } from "@/components/ui/checkbox"

export interface CasillasPermisoProps {
  policyVersion: string
  policyUrl: string
  value: PublicMarketingOptIn
  onChange: (value: PublicMarketingOptIn) => void
  disabled?: boolean
}

/** El formulario dueño crea el estado con permisoInicial(version). Nunca se marca por reservar. */
export const permisoInicial = (policyVersion: string): PublicMarketingOptIn => ({ email: false, whatsapp: false, policyVersion })

export function CasillasPermiso({ policyVersion, policyUrl, value, onChange, disabled }: CasillasPermisoProps) {
  const id = useId()
  useEffect(() => {
    if (value.policyVersion !== policyVersion) onChange(permisoInicial(policyVersion))
  }, [value.policyVersion, policyVersion, onChange])
  // Un cambio de política invalida las casillas anteriores hasta que se vuelvan a elegir.
  const vigente = value.policyVersion === policyVersion ? value : permisoInicial(policyVersion)
  return (
    <fieldset className="space-y-2" disabled={disabled || !policyVersion.trim()}>
      <legend className="mb-2 text-base font-medium">¿Quieres recibir novedades?</legend>
      <p className="mb-3 text-sm text-muted-foreground">
        Es opcional. Puedes reservar sin marcar ninguna casilla y darte de baja cuando quieras.
      </p>
      {(
        [
          ["email", "Quiero recibir novedades y ofertas por correo."],
          ["whatsapp", "Quiero recibir novedades y ofertas por WhatsApp."],
        ] as const
      ).map(([channel, text]) => (
        <label
          key={channel}
          htmlFor={`${id}-${channel}`}
          className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm"
        >
          <Checkbox
            id={`${id}-${channel}`}
            disabled={disabled || !policyVersion.trim()}
            checked={vigente[channel]}
            onCheckedChange={(checked) => onChange({ ...vigente, [channel]: checked === true, policyVersion })}
          />
          <span>{text}</span>
        </label>
      ))}
      <p className="text-xs text-muted-foreground">
        <a
          className="inline-flex min-h-12 items-center underline underline-offset-4"
          href={policyUrl}
          target="_blank"
          rel="noopener noreferrer"
        >
          Política de privacidad
        </a>{" "}
        · Versión {policyVersion}
      </p>
    </fieldset>
  )
}
