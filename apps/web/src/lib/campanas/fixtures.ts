/** Fixtures de diseño. Solo las monta la ruta de ejemplos en desarrollo. No se escriben en Firebase. */
import { CALLABLE_SCHEMAS, CampaignSchema, SegmentSchema, defaultMarketingSettings } from "@llenamos/core"
import { reglaInicial } from "./modelo"

export const fixtureSegmentos = [
  {
    id: "fixture_habituales",
    ...SegmentSchema.parse({
      name: "Habituales que hace tiempo que no vienen",
      revision: 1,
      rule: { ...reglaInicial, minVisits: 3, lastVisitAtLeastDaysAgo: 30, includeNeverVisited: false },
    }),
  },
  {
    id: "fixture_recientes",
    ...SegmentSchema.parse({
      name: "Nos visitaron este mes",
      revision: 1,
      rule: { ...reglaInicial, lastVisitAtMostDaysAgo: 30, includeNeverVisited: false },
    }),
  },
]
export const fixtureAjustes = defaultMarketingSettings("Taberna Lumbre")
export const fixtureCampanas = [
  {
    id: "fixture_otono",
    ...CampaignSchema.parse({
      name: "La mesa de otoño te espera",
      segmentId: "fixture_habituales",
      channel: "email",
      content: {
        title: "Vuelve el sabor de las sobremesas",
        body: "Tenemos carta de otoño y un sitio para ti. Ven a probar los nuevos platos de temporada y quédate un rato más.",
        includeBookingLink: true,
      },
      locationId: null,
      status: "draft",
      scheduledAt: null,
      launchedBy: null,
      stats: { audience: 0, queued: 0, excluded: 0, sent: 0, failed: 0, cancelled: 0 },
      cursor: null,
      revision: 1,
    }),
  },
  {
    id: "fixture_whatsapp",
    ...CampaignSchema.parse({
      name: "Una cena entre semana",
      segmentId: "fixture_recientes",
      channel: "whatsapp",
      content: {
        title: "¿Nos vemos esta semana?",
        body: "La cocina de temporada ya está en marcha. Te esperamos en Lumbre.",
        includeBookingLink: true,
      },
      locationId: null,
      status: "draft",
      scheduledAt: null,
      launchedBy: null,
      stats: { audience: 0, queued: 0, excluded: 0, sent: 0, failed: 0, cancelled: 0 },
      cursor: null,
      revision: 1,
    }),
  },
]
fixtureCampanas.push({
  id: "fixture_verano",
  ...CampaignSchema.parse({
    ...fixtureCampanas[0],
    name: "Una despedida para el verano",
    status: "sent",
    scheduledAt: Date.UTC(2026, 9, 1, 8),
    launchedBy: "fixture_propietario",
    revision: 2,
    stats: { audience: 248, queued: 186, excluded: 62, sent: 0, failed: 2, cancelled: 4 },
  }),
})
const excluded = { no_contact: 8, no_consent: 34, withdrawn: 5, suppressed: 1, frequency: 12, duplicate_contact: 2 }
export const fixtureAudiencia = CALLABLE_SCHEMAS.previsualizarSegmento.output.parse({
  audience: 248,
  recipients: 186,
  excluded,
  sample: [],
})
export const fixtureSimulacion = CALLABLE_SCHEMAS.simularCampana.output.parse({
  ...fixtureAudiencia,
  preview: {
    subject: "Vuelve el sabor de las sobremesas",
    body: "Tenemos carta de otoño y un sitio para ti. Ven a probar los nuevos platos de temporada y quédate un rato más.\n\nReserva tu mesa: http://localhost:3013/r/taberna-lumbre?llc=fixture_otono\n\nTaberna Lumbre\nDejar de recibir novedades: [enlace de baja de muestra]",
  },
  firstSendAt: Date.UTC(2026, 10, 11, 9),
})
export const fixtureInforme = CALLABLE_SCHEMAS.informeCampana.output.parse({
  status: "sent",
  audience: 248,
  queued: 0,
  sent: 0,
  captured: 180,
  notConfigured: 0,
  failed: 2,
  cancelled: 4,
  excluded,
  unsubscribed: 3,
  reservations: 18,
  covers: 52,
  seated: 16,
  salesCents: 124800,
})
export const fixtureOrigen = CALLABLE_SCHEMAS.informeOrigen.output.parse({
  withoutOrigin: 14,
  rows: [
    {
      channel: "google_maps",
      campaignId: null,
      adId: null,
      reservations: 86,
      covers: 234,
      seated: 79,
      noShows: 3,
      cancelled: 4,
      salesCents: 512800,
    },
    {
      channel: "instagram",
      campaignId: null,
      adId: null,
      reservations: 42,
      covers: 118,
      seated: 38,
      noShows: 2,
      cancelled: 2,
      salesCents: 241600,
    },
    {
      channel: "campaign",
      campaignId: "fixture_otono",
      adId: null,
      reservations: 18,
      covers: 52,
      seated: 16,
      noShows: 1,
      cancelled: 1,
      salesCents: 124800,
    },
    {
      channel: "google_ads",
      campaignId: null,
      adId: "otono_cena",
      reservations: 12,
      covers: 34,
      seated: 11,
      noShows: 0,
      cancelled: 1,
      salesCents: 76800,
    },
  ],
})
