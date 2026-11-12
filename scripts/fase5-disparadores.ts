/** Verifica los disparadores reales sin tocar los escritores de reservas ni caja. Datos de prueba. */
import type * as Core from '../packages/core/src/index'
import { entorno } from './fase5-entorno'
async function main() {
  entorno()
  const core=await import('../packages/core/src/index'),{ db }=await import('../functions/src/shared'),{ ts }=await import('../functions/src/fase5/context')
  const host=process.env.FIRESTORE_EMULATOR_HOST!.split(':')[0],root=db.doc('restaurants/demo-lumbre'),p=`${root.path}/locations/centro`,now=Date.now(),id=`fase5-disparador-${now}`,cid=core.customerIdFor('demo-lumbre','+34699000101')
  await fetch(`http://${host}:4412/functions/enableBackgroundTriggers`,{method:'PUT'})
  const before=(await root.collection('loyaltyAccounts').doc(cid).get()).get('balance') as number
  const r=core.ReservationSchema.parse({guestName:'Marc Prueba',phone:'+34699000101',email:null,language:'es',partySize:2,startAt:now,durationMinutes:90,status:'seated',tableIds:['sala-1'],suggestedTableIds:[],suggestionReason:null,source:'phone',notes:'Prueba de disparadores de fase 5',guestNotes:'',customerId:cid,reference:'QW2345',manageTokenHash:core.sha256Hex(id),deposit:{status:'none',amountCents:0,checkoutSessionId:null},history:[],createdBy:null})
  await db.doc(`${p}/reservations/${id}`).create({...core.reservationForWrite(r,n=>ts(n)),createdAt:ts(now),updatedAt:ts(now),updatedBy:null})
  await db.doc(`${p}/tableSessions/${id}`).create({status:'closed',tableIds:['sala-1'],label:'S1',guests:2,reservationId:id,customerId:cid,guestName:'Marc Prueba',waiterUid:null,waiterName:null,notes:'',openedAt:ts(now-3600000),openedBy:null,closedAt:ts(now),closedBy:null,billRequestedAt:null,mergedInto:null,totalCents:4000,lineCount:1,unservedCount:0,history:[],createdAt:ts(now),updatedAt:ts(now),updatedBy:null})
  const bill:Core.Bill={target:{kind:'session',id},customerId:cid,status:'settled',revision:1,lines:[{lineId:id,parentLineId:null,name:'Consumo de prueba',quantity:2,grossCents:4000,taxRate:10,guest:null}],adjustments:[],totalCents:4000,paidCents:4000,refundedCents:0,openedAt:now-3600000,lockedAt:now-1000,settledAt:now}
  await db.doc(`${p}/bills/${id}`).create({...core.billForWrite(bill,n=>ts(n)),createdAt:ts(now),updatedAt:ts(now),updatedBy:null})
  const wait=async(check:()=>Promise<boolean>)=>{ const until=Date.now()+45000;while(Date.now()<until){if(await check())return;await new Promise(resolve=>setTimeout(resolve,250))}throw new Error('El disparador no terminó en 45 segundos.') }
  const earn=root.collection('loyaltyMovements').doc(core.loyaltyMovementId.earn(id)),operation=root.collection('repiteOutbox').doc(core.repiteOperationId.stamp(core.repiteVisitKey({restaurantId:'demo-lumbre',reservationId:id,sessionId:id})))
  await wait(async()=>{const [e,o]=await Promise.all([earn.get(),operation.get()]);return e.exists&&['done','duplicate'].includes(o.get('status'))})
  const paymentId=`refund-${id}`,payment:Core.Payment={billId:id,partId:id,cashSessionId:'demo',kind:'refund',originalPaymentId:'demo',method:'card',status:'succeeded',amountCents:1000,tipCents:0,tenderedCents:0,changeCents:0,externalId:null,requestId:paymentId,reason:'Devolución de prueba local',at:Date.now(),by:null}
  await db.doc(`${p}/bills/${id}`).update({refundedCents:1000,updatedBy:null,updatedAt:ts(Date.now())})
  await db.doc(`${p}/payments/${paymentId}`).create({...core.paymentForWrite(payment,n=>ts(n)),createdAt:ts(now),updatedAt:ts(now),updatedBy:null})
  const reversal=root.collection('loyaltyMovements').doc(core.loyaltyMovementId.earnReversal(paymentId))
  await wait(async()=>(await reversal.get()).exists)
  const after=(await root.collection('loyaltyAccounts').doc(cid).get()).get('balance') as number
  if(after!==before+30)throw new Error(`Saldo incorrecto: ${after}, esperado ${before+30}.`)
  const op=(await operation.get()).data()!
  console.log({puntosGanados:(await earn.get()).get('points'),puntosDevueltos:(await reversal.get()).get('points'),saldoAntes:before,saldoDespues:after,sello:op.status,operacionesDeVisita:1})
  await db.terminate()
}
main().catch(error=>{console.error(error);process.exitCode=1})
