/** Persona sintética sin servicio vivo para demostrar privacidad sin borrar clientes del servicio. */
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '../packages/core/src/index'
import { db } from '../functions/src/shared'
import { localOnly,rootOf } from '../functions/src/fase6-privacy/infra'
async function main() {
localOnly()
const rid='demo-lumbre',cid=core.customerIdFor(rid,'+34699990001'),root=rootOf(rid)
try {
  const now=Date.now()
  await root.collection('customers').doc(cid).set({ name:'Celia Demo privacidad',phone:'+34699990001',email:'celia@ejemplo.test',language:'es',notes:'Prefiere una mesa tranquila',allergies:'Frutos secos',tags:['demo'],visits:1,noShows:0,cancellations:0,lastVisitAt:Timestamp.fromMillis(now-2*86400000),spentCents:2400,createdAt:Timestamp.now(),updatedAt:Timestamp.now(),updatedBy:'lumbre-propietario' })
  await root.collection('privacyEvidence').doc('demo-presencial').set({ customerId:cid,verified:true,method:'in_person',recordedBy:'lumbre-propietario',expiresAt:Timestamp.fromMillis(now+86400000),syntheticDemo:true,updatedAt:Timestamp.now(),updatedBy:'lumbre-propietario' })
  const reservation = core.ReservationSchema.parse({ guestName:'Celia Demo privacidad',phone:'+34699990001',email:'celia@ejemplo.test',language:'es',partySize:2,startAt:now-2*86400000,durationMinutes:90,status:'finished',tableIds:[],suggestedTableIds:[],suggestionReason:null,source:'phone',notes:'Prefiere una mesa tranquila',guestNotes:'Frutos secos',customerId:cid,reference:'PRJV23',manageTokenHash:core.sha256Hex('enlace-demo-privacidad'),deposit:{ status:'none',amountCents:0,checkoutSessionId:null },history:[],createdBy:'lumbre-propietario' })
  await root.collection('locations').doc('centro').collection('reservations').doc('demo-privacidad').set({ ...core.reservationForWrite(reservation,Timestamp.fromMillis),updatedAt:Timestamp.now(),updatedBy:'lumbre-propietario' })
  console.log('Ficha sintética Celia Demo privacidad preparada. Evidencia sintética: demo-presencial. Nunca usar esta evidencia para personas reales.')
} finally { await db.terminate() }

}
main().catch(error => { console.error(error);process.exitCode=1 })
