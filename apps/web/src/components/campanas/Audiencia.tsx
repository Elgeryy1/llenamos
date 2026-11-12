import { CAMPAIGN_EXCLUSIONS, CAMPAIGN_EXCLUSION_LABEL, type CallableOutput } from "@llenamos/core"
import { SummaryStrip } from "@/components/common/summary-strip"

type Recuento = Pick<CallableOutput<"previsualizarSegmento">, "audience" | "recipients" | "excluded">
export function Audiencia({ data }: { data: Recuento }) {
  return (
    <div className="space-y-4">
      <SummaryStrip
        label="Audiencia de la campaña"
        items={[
          { label: "En el segmento", value: data.audience },
          { label: "Con permiso y dentro del límite", value: data.recipients, tone: "success" },
        ]}
      />
      <section className="superficie overflow-hidden">
        <h3 className="border-b px-5 py-3 font-semibold">Por qué se quedan fuera</h3>
        <dl className="divide-y">
          {CAMPAIGN_EXCLUSIONS.map((key) => (
            <div className="flex items-center justify-between gap-5 px-5 py-3 text-sm" key={key}>
              <dt className="text-muted-foreground">{CAMPAIGN_EXCLUSION_LABEL[key]}</dt>
              <dd className="cifra shrink-0 font-medium">{data.excluded[key]}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="text-xs text-muted-foreground">
        No se muestran contactos. El servidor comprueba otra vez los permisos y el límite de frecuencia al preparar y enviar cada mensaje.
      </p>
    </div>
  )
}
