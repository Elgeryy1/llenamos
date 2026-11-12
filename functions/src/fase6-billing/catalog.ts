import type { Transaction } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'

/** Incluye padres ausentes con versiones existentes, sin consultar versiones de recetas. */
export async function catalogPlans(tx?: Transaction) {
  const plans = await db.collection('platformPlans').listDocuments()
  const pages = await Promise.all(plans.map(ref => tx ? tx.get(ref.collection('versions')) : ref.collection('versions').get()))
  return pages.flatMap(page => page.docs.map(doc => core.PlanDefinitionSchema.parse(doc.data())))
}
