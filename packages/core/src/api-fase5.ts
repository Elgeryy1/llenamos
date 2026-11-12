/** Callables de la fase 5 (clientes, marketing y análisis), juntas para registrarlas en `api.ts`. */
import { CALLABLES_FASE5_ANALISIS, CALLABLE_SCHEMAS_FASE5_ANALISIS, FASE5_ANALISIS_ACCESS } from "./api-analisis"
import { CALLABLES_FASE5_FIDELIZACION, CALLABLE_SCHEMAS_FASE5_FIDELIZACION, FASE5_FIDELIZACION_ACCESS } from "./api-fidelizacion"
import { CALLABLES_FASE5_MARKETING, CALLABLE_SCHEMAS_FASE5_MARKETING, FASE5_MARKETING_ACCESS } from "./api-marketing"

export const CALLABLES_FASE5 = { ...CALLABLES_FASE5_FIDELIZACION, ...CALLABLES_FASE5_MARKETING, ...CALLABLES_FASE5_ANALISIS } as const
export const CALLABLE_SCHEMAS_FASE5 = { ...CALLABLE_SCHEMAS_FASE5_FIDELIZACION, ...CALLABLE_SCHEMAS_FASE5_MARKETING, ...CALLABLE_SCHEMAS_FASE5_ANALISIS } as const
/**
 * Permiso y módulos base de cada callable. Además: sesión de Auth, miembro activo y acceso al local
 * (o a todos los locales pedidos). `logiqd` es el claim del equipo interno; `public` no exige sesión.
 */
export const FASE5_ACCESS = { ...FASE5_FIDELIZACION_ACCESS, ...FASE5_MARKETING_ACCESS, ...FASE5_ANALISIS_ACCESS } as const
