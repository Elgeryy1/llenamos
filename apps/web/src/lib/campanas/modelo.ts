import { can, FASE5_ACCESS, type Role, type SegmentRule, type CampaignStatus } from "@llenamos/core"

export const reglaInicial: SegmentRule = {
  minVisits: null,
  maxVisits: null,
  lastVisitAtLeastDaysAgo: null,
  lastVisitAtMostDaysAgo: null,
  includeNeverVisited: true,
  maxNoShows: null,
  minSpentCents: null,
  tagsAny: [],
  tagsNone: [],
  languages: [],
  minPoints: null,
}
export const ESTADO_CAMPANA: Record<CampaignStatus, string> = {
  draft: "Borrador",
  scheduled: "Programada",
  sending: "Preparando mensajes",
  sent: "Preparación terminada",
  cancelled: "Cancelada",
}
export const puedeLanzar = (role: Role) => {
  const permission = FASE5_ACCESS.lanzarCampana.permission
  return permission !== "public" && permission !== "logiqd" && can(role, permission)
}
export const eurosMarketing = (cents: number) => new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(cents / 100)
export const fechaMarketing = (ms: number, timezone: string) =>
  new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(ms)
export const AVISO_WHATSAPP =
  "Esta campaña por WhatsApp no saldrá: falta una cuenta de WhatsApp Business verificada y una plantilla aprobada por Meta. Puedes preparar el borrador y simularlo."
