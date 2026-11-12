import type { CallableInput,CallableOutput } from '@llenamos/core'
import { llamarCore } from '@/lib/data/callables'
export type PrivacyList = CallableOutput<'listarSolicitudesPrivacidad'>
export const listJobs = (restaurantId:string,cursor:string|null = null) => llamarCore('listarSolicitudesPrivacidad',{ restaurantId,cursor,limit:25 })
export const requestPrivacy = (input:CallableInput<'solicitarPrivacidad'>) => llamarCore('solicitarPrivacidad',input)
export const verifyPrivacy = (input:CallableInput<'verificarSolicitudPrivacidad'>) => llamarCore('verificarSolicitudPrivacidad',input)
export const registerConsent = (input:CallableInput<'registrarConsentimiento'>) => llamarCore('registrarConsentimiento',input)
export const downloadExport = (restaurantId:string,jobId:string) => llamarCore('descargarExportacionPrivacidad',{ restaurantId,jobId })
