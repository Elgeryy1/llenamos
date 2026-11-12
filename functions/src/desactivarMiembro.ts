import { onCall } from './identity-call'
import { z } from 'zod'
import { changeMembership } from './changeMembership'
import { id, options, parse, safe, uidOf } from './shared'

export const desactivarMiembro = onCall(options, request => safe(async () => {
  const actor = uidOf(request)
  const input = parse(z.object({ restaurantId: id, uid: id }).strict(), request.data)
  return changeMembership(input.restaurantId, actor, input.uid)
}))
