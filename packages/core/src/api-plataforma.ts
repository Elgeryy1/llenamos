/** Firmas de fase 6. Son contratos para implementar, no servicios ya desplegados. */
import { z } from "zod"
import { DocIdSchema, SlugSchema } from "./model"
import { LinkTokenSchema } from "./ids"
import { MillisSchema } from "./timestamp"
import { ModuleOverridesSchema, ModuleSchema, PlanSchema } from "./modules"
import type { Permission } from "./roles"
import { ReservationSettingsSchema } from "./reservation-settings"
import { PublicMenuSchema } from "./carta/publica"
import { CommandReceiptSchema, OfflineCommandSchema, StableCommandIdSchema, SyncScopeSchema } from "./plataforma/sin-conexion"
import { EntitlementsSchema, OnboardingSchema, PlanDefinitionSchema, PlatformRevisionSchema, SubscriptionSchema } from "./plataforma/planes"
import { ApiScopeSchema, PlatformEventTypeSchema, WebhookEndpointSchema, WebhookDeliverySchema } from "./plataforma/integraciones"
import { ConsentSchema, PrivacyJobSchema } from "./plataforma/privacidad"
import { BackupManifestSchema, RestoreDrillSchema } from "./plataforma/continuidad"
import { RestaurantIntegrationsInputSchema, RestaurantIntegrationStatusSchema, RestaurantProviderSchema } from './integraciones-proveedores'

const Rid = { restaurantId: DocIdSchema }
const Mutation = { ...Rid, requestId: StableCommandIdSchema }
const Revision = { ...Mutation, expectedRevision: PlatformRevisionSchema }
const Reason = z.string().trim().min(1).max(200)
const Page = { cursor: z.string().min(1).max(2000).nullable().default(null), limit: z.number().int().min(1).max(100).default(50) }
const Ok = z.object({ ok: z.literal(true) })
const SetupLink = z.discriminatedUnion("status", [z.object({ status: z.literal("ready"), url: z.url() }), z.object({ status: z.literal("not_configured"), message: z.string() })])
export const PublicPlanDefinitionSchema = z.object(PlanDefinitionSchema.omit({ stripeMonthlyPriceId: true, stripeAnnualPriceId: true }).shape)
export const ListarPlanesDisponiblesInputSchema = z.strictObject({})
export const ListarPlanesDisponiblesOutputSchema = z.object({ plans: z.array(PublicPlanDefinitionSchema) })
export const ListarIntegracionesInputSchema = z.strictObject({ ...Rid, ...Page })
export const ListarIntegracionesOutputSchema = z.object({
  keys: z.array(z.object({ id: DocIdSchema, name: z.string(), prefix: z.string(), scopes: z.array(ApiScopeSchema), locationIds: z.array(DocIdSchema), expiresAt: MillisSchema, revokedAt: MillisSchema.nullable(), lastUsedAt: MillisSchema.nullable() })),
  endpoints: z.array(WebhookEndpointSchema.extend({ id: DocIdSchema })),
  deliveries: z.array(WebhookDeliverySchema.omit({ body: true, bodyHash: true, leaseUntil: true }).extend({ id: DocIdSchema, lastAttemptAt: MillisSchema.nullable().optional() })),
  nextCursor: z.string().nullable(), workerLastRunAt: MillisSchema.nullable().optional(),
})
export const ListarSolicitudesPrivacidadInputSchema = z.strictObject({ ...Rid, ...Page })
export const ListarSolicitudesPrivacidadOutputSchema = z.object({ jobs: z.array(PrivacyJobSchema.omit({ artifactPath: true, cursor: true }).extend({ id: DocIdSchema })), nextCursor: z.string().nullable() })
export const VerContinuidadInputSchema = z.strictObject({ ...Rid, ...Page })
export const VerContinuidadOutputSchema = z.object({
  backups: z.array(BackupManifestSchema.omit({ files: true, keyVersion: true }).extend({ id: DocIdSchema })),
  drills: z.array(RestoreDrillSchema.omit({ isolatedTarget: true }).extend({ id: DocIdSchema })), nextCursor: z.string().nullable(),
})
export const OnboardingDraftSchema = z.strictObject({
  name: z.string().trim().min(2).max(80), slug: SlugSchema,
  location: z.strictObject({ name: z.string().trim().min(2).max(80), address: z.string().max(200), city: z.string().max(80), phone: z.string().max(30) }),
  settings: ReservationSettingsSchema, planId: DocIdSchema, planVersion: PlatformRevisionSchema,
  acceptedTermsVersion: z.string().min(1).max(80),
  /** Plano inicial y carta opcional; el servidor crea los documentos operativos. */
  floor: z.strictObject({ areaName: z.string().trim().min(1).max(40), tableCount: z.number().int().min(1).max(24), seats: z.number().int().min(1).max(12) }).optional(),
  menu: z.array(z.strictObject({ name: z.string().trim().min(1).max(80), priceCents: z.number().int().min(0).max(10_000_000) })).max(30).optional(),
})
export type OnboardingDraft = z.infer<typeof OnboardingDraftSchema>
/** Datos de plataforma, nunca métricas o documentos operativos del restaurante. */
export const AdministrativeRestaurantSchema = z.object({
  restaurantId: DocIdSchema, name: z.string(), slug: SlugSchema, ownerEmail: z.email(),
  planId: DocIdSchema, planVersion: PlatformRevisionSchema, status: z.string(),
  activeModules: z.array(ModuleSchema), moduleOverrides: ModuleOverridesSchema,
  revision: PlatformRevisionSchema,
  integrationStatus: RestaurantIntegrationStatusSchema.optional(),
})
export type AdministrativeRestaurant = z.infer<typeof AdministrativeRestaurantSchema>
export const AltaRestauranteLogiqdInputSchema = z.strictObject({
  requestId: StableCommandIdSchema, ownerEmail: z.email().max(254), ownerName: z.string().trim().min(1).max(80),
  name: z.string().trim().min(2).max(80), slug: SlugSchema,
  locationName: z.string().trim().min(2).max(80), planId: DocIdSchema, planVersion: PlatformRevisionSchema,
  integrations: RestaurantIntegrationsInputSchema.optional(),
})
export const AltaRestauranteLogiqdOutputSchema = z.object({ restaurantId: DocIdSchema, locationId: DocIdSchema, invitationStatus: z.enum(['sent', 'pending']) })
export const ListarRestaurantesAdministracionInputSchema = z.strictObject(Page)
export const ListarRestaurantesAdministracionOutputSchema = z.object({ restaurants: z.array(AdministrativeRestaurantSchema), nextCursor: z.string().nullable() })
export const ConfigurarRestauranteLogiqdInputSchema = z.strictObject({
  ...Revision, planId: DocIdSchema, planVersion: PlatformRevisionSchema,
  moduleOverrides: ModuleOverridesSchema, reason: Reason, serviceUntil: MillisSchema.optional(),
  integrations: RestaurantIntegrationsInputSchema.optional(), removeIntegrations: z.array(RestaurantProviderSchema).max(5).optional(),
})
export const ConfigurarRestauranteLogiqdOutputSchema = z.object({ restaurant: AdministrativeRestaurantSchema })
export type PublicPlanDefinition = z.infer<typeof PublicPlanDefinitionSchema>
export const GuardarAltaInputSchema = z.strictObject({
  requestId: StableCommandIdSchema, onboardingId: DocIdSchema.nullable(),
  expectedRevision: PlatformRevisionSchema.nullable(), step: OnboardingSchema.shape.step.exclude(["done"]),
  draft: OnboardingDraftSchema.partial(),
}).refine((v) => (v.onboardingId === null) === (v.expectedRevision === null), "Indica la revisión del borrador existente.")
export const GuardarAltaOutputSchema = z.object({ onboardingId: DocIdSchema, onboarding: OnboardingSchema })
export const CompletarAltaInputSchema = z.strictObject({ requestId: StableCommandIdSchema, onboardingId: DocIdSchema, expectedRevision: PlatformRevisionSchema })
export const CompletarAltaOutputSchema = z.object({ restaurantId: DocIdSchema, locationId: DocIdSchema, subscription: SubscriptionSchema, entitlements: EntitlementsSchema })
export const VerSuscripcionInputSchema = z.strictObject(Rid)
export const VerSuscripcionOutputSchema = z.object({ subscription: SubscriptionSchema, entitlements: EntitlementsSchema, plan: PublicPlanDefinitionSchema })
export const IniciarSuscripcionInputSchema = z.strictObject({ ...Revision, planId: DocIdSchema, planVersion: PlatformRevisionSchema, interval: z.enum(["month", "year"]) })
export const IniciarSuscripcionOutputSchema = SetupLink
export const AbrirPortalFacturacionInputSchema = z.strictObject(Mutation)
export const AbrirPortalFacturacionOutputSchema = SetupLink
export const CancelarSuscripcionInputSchema = z.strictObject({ ...Revision, reason: Reason })
export const CancelarSuscripcionOutputSchema = z.discriminatedUnion("status", [z.object({ status: z.literal("scheduled"), endsAt: MillisSchema }), z.object({ status: z.literal("not_configured"), message: z.string() })])
export const GuardarPlanPlataformaInputSchema = z.strictObject({ requestId: StableCommandIdSchema, plan: PlanDefinitionSchema })
export const GuardarPlanPlataformaOutputSchema = Ok
export const CambiarExcepcionesPlataformaInputSchema = z.strictObject({ ...Revision, moduleOverrides: ModuleOverridesSchema, reason: Reason })
export const CambiarExcepcionesPlataformaOutputSchema = z.object({ entitlements: EntitlementsSchema })
export const SincronizarComandoInputSchema = z.strictObject({ command: OfflineCommandSchema })
export const SincronizarComandoOutputSchema = z.object({ receipt: CommandReceiptSchema })
export const RecuperarComandoInputSchema = z.strictObject({ ...SyncScopeSchema.shape, commandId: StableCommandIdSchema })
export const RecuperarComandoOutputSchema = z.object({ receipt: CommandReceiptSchema.nullable() })
export const DescartarComandoInputSchema = z.strictObject({ command: OfflineCommandSchema, requestId: StableCommandIdSchema, reason: Reason })
export const DescartarComandoOutputSchema = z.object({ receipt: CommandReceiptSchema })
export const ListarRestaurantesLogiqdInputSchema = z.strictObject({ ...Page, status: z.enum(["all", "trialing", "active", "past_due", "suspended", "cancelled", "not_configured"]).default("all") })
export const UsageSnapshotSchema = z.object({
  restaurantId: DocIdSchema, name: z.string(), planId: DocIdSchema, status: SubscriptionSchema.shape.status,
  locations: z.number().int().min(0), members: z.number().int().min(0), apiKeys: z.number().int().min(0), webhooks: z.number().int().min(0),
  pendingCommands: z.number().int().min(0), failedDeliveries: z.number().int().min(0), measuredAt: MillisSchema,
  activeModules: z.array(ModuleSchema).optional(), moduleOverrides: ModuleOverridesSchema.optional(),
  legacyPlan: PlanSchema.optional(), platformRevision: PlatformRevisionSchema.nullable().optional(),
})
export type UsageSnapshot = z.infer<typeof UsageSnapshotSchema>
export const ListarRestaurantesLogiqdOutputSchema = z.object({ restaurants: z.array(UsageSnapshotSchema), nextCursor: z.string().nullable() })
export const VerUsoPlataformaInputSchema = z.strictObject(Rid)
export const VerUsoPlataformaOutputSchema = UsageSnapshotSchema
export const AbrirAccesoSoporteInputSchema = z.strictObject({ ...Mutation, reason: Reason, durationMinutes: z.number().int().min(1).max(60) })
export const AbrirAccesoSoporteOutputSchema = z.object({ supportAccessId: DocIdSchema, expiresAt: MillisSchema })
export const CrearClaveApiInputSchema = z.strictObject({ ...Mutation, name: z.string().trim().min(1).max(80), scopes: z.array(ApiScopeSchema).min(1).max(2), locationIds: z.array(DocIdSchema).min(1).max(100), expiresAt: MillisSchema })
export const CrearClaveApiOutputSchema = z.object({ keyId: DocIdSchema, token: LinkTokenSchema, prefix: z.string() })
export const RevocarClaveApiInputSchema = z.strictObject({ ...Mutation, keyId: DocIdSchema })
export const RevocarClaveApiOutputSchema = Ok
export const GuardarWebhookInputSchema = z.strictObject({ ...Mutation, endpointId: DocIdSchema.nullable(), url: WebhookEndpointSchema.shape.url, events: z.array(PlatformEventTypeSchema).min(1), locationIds: z.array(DocIdSchema).min(1).max(100), status: WebhookEndpointSchema.shape.status })
export const GuardarWebhookOutputSchema = z.object({ endpointId: DocIdSchema, secret: LinkTokenSchema.nullable(), secretVersion: z.number().int().min(1) })
export const RotarSecretoWebhookInputSchema = z.strictObject({ ...Mutation, endpointId: DocIdSchema })
export const RotarSecretoWebhookOutputSchema = z.object({ secret: LinkTokenSchema, secretVersion: z.number().int().min(1) })
export const RepetirEntregaWebhookInputSchema = z.strictObject({ ...Mutation, deliveryId: DocIdSchema, reason: Reason })
export const RepetirEntregaWebhookOutputSchema = z.object({ deliveryId: DocIdSchema, status: WebhookDeliverySchema.shape.status })
export const RegistrarConsentimientoInputSchema = z.strictObject({ ...Mutation, customerId: DocIdSchema, purpose: ConsentSchema.shape.purpose, status: ConsentSchema.shape.status, policyVersion: z.string().min(1).max(80), evidenceId: DocIdSchema })
export const RegistrarConsentimientoOutputSchema = z.object({ consentId: DocIdSchema })
export const SolicitarPrivacidadInputSchema = z.strictObject({ ...Mutation, customerId: DocIdSchema, kind: z.enum(["export", "erase"]), reason: Reason })
export const SolicitarPrivacidadOutputSchema = z.object({ jobId: DocIdSchema, job: PrivacyJobSchema })
export const VerificarSolicitudPrivacidadInputSchema = z.strictObject({ ...Mutation, jobId: DocIdSchema, evidenceId: DocIdSchema })
export const VerificarSolicitudPrivacidadOutputSchema = Ok
export const DescargarExportacionPrivacidadInputSchema = z.strictObject({ ...Rid, jobId: DocIdSchema })
export const DescargarExportacionPrivacidadOutputSchema = z.object({ url: z.url(), expiresAt: MillisSchema })
export const CrearCopiaSeguridadInputSchema = z.strictObject({ ...Mutation, reason: Reason })
export const CrearCopiaSeguridadOutputSchema = z.object({ backupId: DocIdSchema, manifest: BackupManifestSchema })
export const SimularRestauracionInputSchema = z.strictObject({ ...Mutation, backupId: DocIdSchema })
export const SimularRestauracionOutputSchema = z.object({ drillId: DocIdSchema, drill: RestoreDrillSchema })

/** HTTP GET /v1/restaurants/:restaurantId/locations/:locationId/{menu,orders}. */
export const ApiReadInputSchema = z.strictObject({ ...Rid, locationId: DocIdSchema, ...Page })
export const ApiMenuOutputSchema = z.object({ menu: PublicMenuSchema })
export const ApiOrdersOutputSchema = z.object({
  orders: z.array(z.object({ id: DocIdSchema, placedAt: MillisSchema, status: z.enum(["pending_approval", "accepted", "rejected"]), totalCents: z.number().int().min(0), lineIds: z.array(DocIdSchema) })), nextCursor: z.string().nullable(),
})

export const CALLABLE_SCHEMAS_FASE6 = {
  altaRestauranteLogiqd: { input: AltaRestauranteLogiqdInputSchema, output: AltaRestauranteLogiqdOutputSchema },
  configurarRestauranteLogiqd: { input: ConfigurarRestauranteLogiqdInputSchema, output: ConfigurarRestauranteLogiqdOutputSchema },
  listarRestaurantesAdministracion: { input: ListarRestaurantesAdministracionInputSchema, output: ListarRestaurantesAdministracionOutputSchema },
  listarPlanesDisponibles: { input: ListarPlanesDisponiblesInputSchema, output: ListarPlanesDisponiblesOutputSchema },
  listarIntegraciones: { input: ListarIntegracionesInputSchema, output: ListarIntegracionesOutputSchema },
  listarSolicitudesPrivacidad: { input: ListarSolicitudesPrivacidadInputSchema, output: ListarSolicitudesPrivacidadOutputSchema },
  verContinuidad: { input: VerContinuidadInputSchema, output: VerContinuidadOutputSchema },
  guardarAlta: { input: GuardarAltaInputSchema, output: GuardarAltaOutputSchema },
  completarAlta: { input: CompletarAltaInputSchema, output: CompletarAltaOutputSchema },
  verSuscripcion: { input: VerSuscripcionInputSchema, output: VerSuscripcionOutputSchema },
  iniciarSuscripcion: { input: IniciarSuscripcionInputSchema, output: IniciarSuscripcionOutputSchema },
  abrirPortalFacturacion: { input: AbrirPortalFacturacionInputSchema, output: AbrirPortalFacturacionOutputSchema },
  cancelarSuscripcion: { input: CancelarSuscripcionInputSchema, output: CancelarSuscripcionOutputSchema },
  guardarPlanPlataforma: { input: GuardarPlanPlataformaInputSchema, output: GuardarPlanPlataformaOutputSchema },
  cambiarExcepcionesPlataforma: { input: CambiarExcepcionesPlataformaInputSchema, output: CambiarExcepcionesPlataformaOutputSchema },
  sincronizarComando: { input: SincronizarComandoInputSchema, output: SincronizarComandoOutputSchema },
  recuperarComando: { input: RecuperarComandoInputSchema, output: RecuperarComandoOutputSchema },
  descartarComando: { input: DescartarComandoInputSchema, output: DescartarComandoOutputSchema },
  listarRestaurantesLogiqd: { input: ListarRestaurantesLogiqdInputSchema, output: ListarRestaurantesLogiqdOutputSchema },
  verUsoPlataforma: { input: VerUsoPlataformaInputSchema, output: VerUsoPlataformaOutputSchema },
  abrirAccesoSoporte: { input: AbrirAccesoSoporteInputSchema, output: AbrirAccesoSoporteOutputSchema },
  crearClaveApi: { input: CrearClaveApiInputSchema, output: CrearClaveApiOutputSchema },
  revocarClaveApi: { input: RevocarClaveApiInputSchema, output: RevocarClaveApiOutputSchema },
  guardarWebhook: { input: GuardarWebhookInputSchema, output: GuardarWebhookOutputSchema },
  rotarSecretoWebhook: { input: RotarSecretoWebhookInputSchema, output: RotarSecretoWebhookOutputSchema },
  repetirEntregaWebhook: { input: RepetirEntregaWebhookInputSchema, output: RepetirEntregaWebhookOutputSchema },
  registrarConsentimiento: { input: RegistrarConsentimientoInputSchema, output: RegistrarConsentimientoOutputSchema },
  solicitarPrivacidad: { input: SolicitarPrivacidadInputSchema, output: SolicitarPrivacidadOutputSchema },
  verificarSolicitudPrivacidad: { input: VerificarSolicitudPrivacidadInputSchema, output: VerificarSolicitudPrivacidadOutputSchema },
  descargarExportacionPrivacidad: { input: DescargarExportacionPrivacidadInputSchema, output: DescargarExportacionPrivacidadOutputSchema },
  crearCopiaSeguridad: { input: CrearCopiaSeguridadInputSchema, output: CrearCopiaSeguridadOutputSchema },
  simularRestauracion: { input: SimularRestauracionInputSchema, output: SimularRestauracionOutputSchema },
} as const
export const CALLABLES_FASE6 = {
  altaRestauranteLogiqd: 'altaRestauranteLogiqd', configurarRestauranteLogiqd: 'configurarRestauranteLogiqd',
  listarRestaurantesAdministracion: 'listarRestaurantesAdministracion',
  listarPlanesDisponibles: "listarPlanesDisponibles", listarIntegraciones: "listarIntegraciones", listarSolicitudesPrivacidad: "listarSolicitudesPrivacidad", verContinuidad: "verContinuidad",
  guardarAlta: "guardarAlta", completarAlta: "completarAlta", verSuscripcion: "verSuscripcion", iniciarSuscripcion: "iniciarSuscripcion", abrirPortalFacturacion: "abrirPortalFacturacion", cancelarSuscripcion: "cancelarSuscripcion",
  guardarPlanPlataforma: "guardarPlanPlataforma", cambiarExcepcionesPlataforma: "cambiarExcepcionesPlataforma", sincronizarComando: "sincronizarComando", recuperarComando: "recuperarComando", descartarComando: "descartarComando",
  listarRestaurantesLogiqd: "listarRestaurantesLogiqd", verUsoPlataforma: "verUsoPlataforma", abrirAccesoSoporte: "abrirAccesoSoporte", crearClaveApi: "crearClaveApi", revocarClaveApi: "revocarClaveApi", guardarWebhook: "guardarWebhook", rotarSecretoWebhook: "rotarSecretoWebhook", repetirEntregaWebhook: "repetirEntregaWebhook",
  registrarConsentimiento: "registrarConsentimiento", solicitarPrivacidad: "solicitarPrivacidad", verificarSolicitudPrivacidad: "verificarSolicitudPrivacidad", descargarExportacionPrivacidad: "descargarExportacionPrivacidad", crearCopiaSeguridad: "crearCopiaSeguridad", simularRestauracion: "simularRestauracion",
} as const
export type PlatformAccess = { permission: Permission | "authenticated" | "logiqd" | "per_command"; modules: readonly ("reservations" | "floor" | "kitchen" | "pos" | "repite")[] }
export const FASE6_ACCESS = {
  altaRestauranteLogiqd: { permission: 'logiqd', modules: [] },
  configurarRestauranteLogiqd: { permission: 'logiqd', modules: [] },
  listarRestaurantesAdministracion: { permission: 'logiqd', modules: [] },
  listarPlanesDisponibles: { permission: "authenticated", modules: [] },
  listarIntegraciones: { permission: "integraciones.gestionar", modules: [] },
  listarSolicitudesPrivacidad: { permission: "privacidad.gestionar", modules: [] },
  verContinuidad: { permission: "privacidad.gestionar", modules: [] },
  guardarAlta: { permission: "authenticated", modules: [] }, completarAlta: { permission: "authenticated", modules: [] },
  verSuscripcion: { permission: "planes.ver", modules: [] }, iniciarSuscripcion: { permission: "planes.gestionar", modules: [] }, abrirPortalFacturacion: { permission: "planes.gestionar", modules: [] }, cancelarSuscripcion: { permission: "planes.gestionar", modules: [] },
  guardarPlanPlataforma: { permission: "logiqd", modules: [] }, cambiarExcepcionesPlataforma: { permission: "logiqd", modules: [] },
  sincronizarComando: { permission: "per_command", modules: [] }, recuperarComando: { permission: "per_command", modules: [] }, descartarComando: { permission: "per_command", modules: [] },
  listarRestaurantesLogiqd: { permission: "logiqd", modules: [] }, verUsoPlataforma: { permission: "planes.ver", modules: [] }, abrirAccesoSoporte: { permission: "logiqd", modules: [] },
  crearClaveApi: { permission: "integraciones.gestionar", modules: [] }, revocarClaveApi: { permission: "integraciones.gestionar", modules: [] }, guardarWebhook: { permission: "integraciones.gestionar", modules: [] }, rotarSecretoWebhook: { permission: "integraciones.gestionar", modules: [] }, repetirEntregaWebhook: { permission: "integraciones.gestionar", modules: [] },
  registrarConsentimiento: { permission: "privacidad.gestionar", modules: [] }, solicitarPrivacidad: { permission: "privacidad.gestionar", modules: [] }, verificarSolicitudPrivacidad: { permission: "privacidad.gestionar", modules: [] }, descargarExportacionPrivacidad: { permission: "privacidad.gestionar", modules: [] },
  crearCopiaSeguridad: { permission: "privacidad.gestionar", modules: [] }, simularRestauracion: { permission: "privacidad.gestionar", modules: [] },
} as const satisfies Record<keyof typeof CALLABLES_FASE6, PlatformAccess>
