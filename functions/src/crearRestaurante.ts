import { onCall } from './identity-call'
import { z } from 'zod'
import { options, parse, safe, uidOf } from './shared'
import { legacyCreate } from './fase6-billing/onboarding'

// Conserva la firma anterior y pasa por la misma reserva de slug, cuotas y prueba.
export const crearRestaurante = onCall(options, request => safe(async () => {
  const uid = uidOf(request)
  const input = parse(z.object({ name: z.string().trim().min(2).max(80), locationName: z.string().trim().min(2).max(80) }).strict(), request.data)
  return legacyCreate(uid, input.name, input.locationName)
}))
