/** Integración real de fase 5 en la fila 2. Sin interceptar respuestas ni usar proveedores remotos.
 * Ejecutar con scripts/fase5-verificar.ts, tras los seeds base, servicio, caja, fase 4 y fase 5.
 * Las mutaciones de personal se llaman por HTTP desde Chromium; la reserva y la baja usan su interfaz.
 */
import type * as Core from '../packages/core/src/index'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { Page, Browser, BrowserContext } from '/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright'
import { entorno } from './fase5-entorno'

const WEB = 'http://localhost:3012', API = 'http://127.0.0.1:5013/demo-llenamos/europe-west1'
const OUT = 'docs/diseno/capturas/fase5', rid = 'demo-lumbre', lid = 'centro'
const scope = { restaurantId:rid,locationId:lid }, mutation = () => ({ ...scope,requestId:randomUUID() })
const resultado: Record<string,unknown> = {}, capturas: { archivo:string;descripcion:string }[] = []
const esperar = async <T>(work:() => Promise<T>, name:string, valid:(v:T)=>boolean, ms=60000):Promise<T> => {
  const limit=Date.now()+ms
  while (Date.now()<limit) { const value=await work();if(valid(value))return value;await new Promise(resolve=>setTimeout(resolve,350)) }
  throw new Error(`No terminó: ${name}`)
}
async function screenshot(page:Page, archivo:string, descripcion:string) {
  await page.addStyleTag({ content:'nextjs-portal { display:none }' })
  await page.screenshot({ path:`${OUT}/${archivo}.png`,fullPage:true })
  capturas.push({ archivo:`${archivo}.png`,descripcion })
}
async function session(browser:Browser, email?:string, viewport={width:1440,height:900}) {
  const context=await browser.newContext({viewport,deviceScaleFactor:2}),page=await context.newPage()
  if(email) {
    console.log('Entrando',email);await page.goto(`${WEB}/entrar`)
    await page.getByLabel('Correo').fill(email)
    await page.getByLabel('Contraseña',{exact:true}).fill('Llenamos2026!')
    await page.getByRole('button',{name:'Entrar',exact:true}).click()
    await page.waitForURL('**/panel',{timeout:60000});console.log('Sesión lista',email)
  }
  return { context,page }
}
async function main() {
  entorno();process.env.REPITE_API_URL=`${API}/repiteLocal`;process.env.REPITE_API_TOKEN='local';process.env.FUNCTIONS_EMULATOR='true';process.env.PUBLIC_APP_URL=WEB
  mkdirSync(OUT,{recursive:true})
  const require=createRequire(import.meta.url)
  let pw:typeof import('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')
  try {pw=require('playwright')}catch{pw=require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')}
  const core=await import('../packages/core/src/index'),{db,auth}=await import('../functions/src/shared'),{Timestamp}=await import('firebase-admin/firestore')
  const root=db.doc(`restaurants/${rid}`),local=root.collection('locations').doc(lid),now=Date.now(),today=core.horaLocal(now,'Europe/Madrid').fecha
  const slug=String((await root.get()).get('slug')),phone=`+34698${String(now).slice(-6)}`,cid=core.customerIdFor(rid,phone),name=`Clara Integración ${String(now).slice(-4)}`
  const browser=await pw.chromium.launch({headless:true,executablePath:'/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',args:['--no-sandbox']})
  const contexts:BrowserContext[]=[]
  try {
    await fetch('http://127.0.0.1:4412/functions/enableBackgroundTriggers',{method:'PUT'})
    const {page:owner,context:ownerContext}=await session(browser,'propietario@lumbre.test');contexts.push(ownerContext)
    const identity=await owner.evaluate(async()=>{
      const r=await fetch('http://127.0.0.1:9103/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'propietario@lumbre.test',password:'Llenamos2026!',returnSecureToken:true})});return await r.json() as {idToken:string}
    })
    const call=async <N extends keyof typeof core.CALLABLE_SCHEMAS>(name:N,data:unknown):Promise<Core.CallableOutput<N>> => owner.evaluate(async({api,name,data,token})=>{
      const response=await fetch(`${api}/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({data})})
      const body=await response.json();if(body.error)throw new Error(`${name}: ${JSON.stringify(body.error)}`);return body.result
    },{api:API,name,data,token:identity.idToken})
    // Datos auxiliares: una mesa libre y horario público del demo, sin inventar resultados del recorrido.
    for (const table of (await local.collection('tables').get()).docs) if (table.id.startsWith('fase5-')) await table.ref.update({updatedBy:'lumbre-propietario'})
    for (const customer of (await root.collection('customers').get()).docs) if (customer.get('updatedBy')===null) await customer.ref.update({updatedBy:'lumbre-propietario'})
    const tableId=`fase5-${now}`
    await local.collection('tables').doc(tableId).set({name:'Mesa integración',areaId:'sala',seats:2,enabled:true,joinableWith:[],shape:'rect',x:65,y:65,w:10,h:10,updatedBy:'lumbre-propietario'})
    const settings=core.ReservationSettingsSchema.parse((await local.collection('settings').doc('reservations').get()).data())
    settings.publicBooking=true;settings.autoConfirm=true;settings.minNoticeMinutes=0;settings.deposit={mode:'none',amountCents:0,fromPartySize:1}
    const shifts=[{name:'Servicio de integración',from:'00:00',lastEntry:'23:30'}]
    settings.week={mon:shifts,tue:shifts,wed:shifts,thu:shifts,fri:shifts,sat:shifts,sun:shifts}
    await call('guardarConfiguracionReservas',{...scope,settings})
    await esperar(()=>db.doc(`publicRestaurants/${slug}`).get(),'proyección pública',s=>s.get('bookingEnabled')===true)
    // Campaña y segmento exclusivos: cliente nuevo con permiso y dos controles sin permiso.
    const rule:Core.SegmentRule={minVisits:null,maxVisits:null,lastVisitAtLeastDaysAgo:null,lastVisitAtMostDaysAgo:null,includeNeverVisited:true,maxNoShows:null,minSpentCents:null,tagsAny:[`integracion-${now}`],tagsNone:[],languages:[],minPoints:null}
    const segment=await call('guardarSegmento',{restaurantId:rid,requestId:randomUUID(),segmentId:null,expectedRevision:null,segment:{name:'Integración con permiso',rule}})
    const campaign=await call('guardarCampana',{restaurantId:rid,requestId:randomUUID(),campaignId:null,expectedRevision:null,campaign:{name:`Recorrido ${now}`,segmentId:segment.segmentId,channel:'email',content:{title:'Una mesa para volver',body:'Te esperamos en Lumbre.',includeBookingLink:true},locationId:lid}})
    const {page:guest,context:guestContext}=await session(browser,undefined,{width:390,height:844});contexts.push(guestContext)
    console.log('Paso: publica')
    await guest.goto(core.campaignLink(WEB,slug,campaign.campaignId,'email'))
    await guest.getByRole('radio',{name:/^\d{2}:\d{2}$/}).first().click({timeout:60000})
    await guest.getByRole('button',{name:'Continuar',exact:true}).click()
    await guest.locator('[data-campo="name"]').fill(name);await guest.locator('[data-campo="phone"]').fill(phone);await guest.locator('[data-campo="email"]').fill(`integracion-${now}@lumbre.test`)
    assert.equal(await guest.getByRole('checkbox',{name:'Quiero recibir novedades y ofertas por correo.'}).isChecked(),false)
    await guest.getByRole('checkbox',{name:'Quiero recibir novedades y ofertas por correo.'}).check()
    await guest.locator('#reserva-acceptPolicy').check()
    await screenshot(guest,'01-reserva-consentimiento-movil','Reserva pública móvil con origen de campaña y permiso opcional por correo.')
    const bookingResponse=guest.waitForResponse(r=>r.url().endsWith('/crearReservaPublica'))
    await guest.getByRole('button',{name:/Confirmar reserva|Reservar mesa/}).click()
    const bookingBody=await (await bookingResponse).json();assert.ok(!bookingBody.error,JSON.stringify(bookingBody))
    const booking=bookingBody.result as Core.CallableOutput<'crearReservaPublica'>
    await guest.waitForURL('**/reserva/**',{timeout:60000});await guest.getByText(booking.reference,{exact:true}).first().waitFor();await screenshot(guest,'02-reserva-confirmada','Reserva creada por la interfaz pública y confirmada por el servidor.')
    const reservation=(await local.collection('reservations').where('reference','==',booking.reference).get()).docs[0]!
    assert.equal((await local.collection('reservationOrigins').doc(reservation.id).get()).get('campaignId'),campaign.campaignId)
    const consents=(await root.collection('consents').where('customerId','==',cid).get()).docs.map(d=>core.ConsentSchema.parse(d.data()))
    assert.equal(consents.length,1);assert.equal(consents[0]!.purpose,'marketing_email')
    await esperar(()=>root.collection('customers').doc(cid).get(),'ficha del cliente',s=>s.exists)
    await root.collection('customers').doc(cid).update({tags:[`integracion-${now}`],updatedBy:'lumbre-propietario'})
    const loyaltySettings=core.LoyaltySettingsSchema.parse(Object.fromEntries(Object.entries((await root.collection('settings').doc('loyalty').get()).data()!).filter(([k])=>!['updatedAt','createdAt','updatedBy'].includes(k))))
    await call('altaFidelizacion',{restaurantId:rid,requestId:randomUUID(),customerId:cid,acceptedTermsVersion:loyaltySettings.termsVersion})
    console.log('Paso: sentar')
    await call('asignarMesas',{...scope,reservationId:reservation.id,tableIds:[tableId]})
    await call('cambiarEstadoReserva',{...scope,reservationId:reservation.id,status:'seated'})
    const session1=(await local.collection('tableSessions').where('reservationId','==',reservation.id).get()).docs[0]!
    const stampKey=core.repiteOperationId.stamp(core.repiteVisitKey({restaurantId:rid,reservationId:reservation.id,sessionId:session1.id}))
    await esperar(()=>root.collection('repiteOutbox').doc(stampKey).get(),'sello de Repite',s=>s.get('status')==='done')
    const firstCard=await call('verTarjetaRepite',{restaurantId:rid,customerId:cid});assert.equal(firstCard.status,'ready');if(firstCard.status==='ready')assert.equal(firstCard.card.stamps,1)
    await owner.goto(`${WEB}/panel/clientes`);await owner.getByRole('searchbox',{name:'Buscar cliente'}).fill(name);await owner.getByRole('row',{name:`Abrir la ficha de ${name}`}).click()
    await owner.getByText('Disponibles',{exact:true}).first().waitFor();await owner.getByText(`Fidelización de ${name}`,{exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));await screenshot(owner,'03-cliente-puntos-repite','Ficha integrada con alta de puntos y un sello confirmado en el doble local de Repite.')
    await owner.getByText('Tarjeta Repite',{exact:true}).evaluate(el=>el.scrollIntoView({block:'start'}));await screenshot(owner,'03b-tarjeta-repite','Tarjeta con un sello confirmado por el doble de Repite en la ficha de cliente.')
    const items=(await local.collection('menuItems').get()).docs
    const item=items.find(d=>/bravas/i.test(JSON.stringify(d.data()))) ?? items.find(d=>!d.get('variants')?.length)!
    assert.ok(item,'Falta carta del seed de servicio')
    const order=async(sessionId:string)=>{
      const ordered=await call('enviarPedido',{...scope,sessionId,requestId:randomUUID(),lines:[{kind:'item',itemId:item.id,quantity:10}],fire:'auto'})
      assert.equal(ordered.status,'sent');if(ordered.status!=='sent')throw new Error(JSON.stringify(ordered))
      await call('cambiarEstadoLineas',{...scope,lineIds:ordered.lineIds,status:'served'})
      return ordered
    }
    console.log('Paso: pedir')
    const ordered=await order(session1.id)
    const opened=await call('abrirCuenta',{...mutation(),target:{kind:'session',id:session1.id}})
    const promo=(await root.collection('promotions').get()).docs.find(d=>d.get('stacking')==='with_loyalty')!
    // Promoción local válida todos los días para que el recorrido sea repetible cualquier fecha.
    const promotion=core.PromotionSchema.parse(promo.data())
    const {status:_status,uses:_uses,revision:_rev,...editablePromotion}=promotion
    const edited=await call('guardarPromocion',{restaurantId:rid,requestId:randomUUID(),promotionId:promo.id,expectedRevision:promotion.revision,promotion:{...editablePromotion,weekdays:[],perCustomerLimit:20}})
    void edited
    const applied=await call('aplicarPromocion',{...mutation(),billId:opened.billId,expectedBillRevision:opened.bill.revision,promotionId:promo.id,code:null});assert.equal(applied.status,'applied')
    await owner.goto(`${WEB}/panel/caja?bill=${opened.billId}`)
    // Abrir la cuenta desde la lista real si la pantalla no usa el parámetro de URL.
    const mesa=owner.getByRole('button',{name:new RegExp(name)}).first();await mesa.waitFor({timeout:60000});await mesa.click()
    await owner.getByText('Promociones y puntos',{exact:true}).first().waitFor({timeout:60000})
    await screenshot(owner,'04-cuenta-promocion','Cuenta real con la promoción calculada por el servidor y ajustes rotulados como descuento.')
    const cash=(await local.collection('registerLocks').doc('principal').get()).get('cashSessionId') as string
    assert.ok(cash,'Ejecuta el seed de caja')
    const pay=async(billId:string)=>{
      const view=await call('verCuenta',{...scope,billId})
      const prepared=await call('prepararCobro',{...mutation(),billId,expectedRevision:view.bill.revision})
      const current=await call('verCuenta',{...scope,billId})
      return call('registrarCobro',{...mutation(),billId,expectedRevision:prepared.revision,partId:current.parts[0]!.id,cashSessionId:cash,method:'cash',amountCents:current.bill.totalCents,tenderedCents:current.bill.totalCents,tipCents:0})
    }
    const paid=await pay(opened.billId)
    const earned=await esperar(()=>root.collection('loyaltyMovements').doc(core.loyaltyMovementId.earn(opened.billId)).get(),'puntos del cobro',s=>s.exists)
    const bill1=core.BillSchema.parse((await local.collection('bills').doc(opened.billId).get()).data())
    assert.equal(earned.get('points'),core.pointsForSpend(bill1.totalCents,loyaltySettings))
    const afterPaid=await call('verTarjetaRepite',{restaurantId:rid,customerId:cid});if(afterPaid.status==='ready')assert.equal(afterPaid.card.stamps,1)
    assert.equal((await root.collection('repiteOutbox').where('visitKey','==',core.repiteVisitKey({restaurantId:rid,reservationId:reservation.id,sessionId:session1.id})).get()).size,1)
    await call('cambiarEstadoMesa',{...scope,sessionId:session1.id,status:'closed'})
    const visit2=await call('abrirMesa',{...scope,tableIds:[tableId],guests:2,guest:{name,phone}})
    await order(visit2.sessionId)
    const opened2=await call('abrirCuenta',{...mutation(),target:{kind:'session',id:visit2.sessionId}})
    const reward=(await root.collection('loyaltyRewards').get()).docs.find(d=>d.get('pointsCost')===30)!
    const redeem=await call('canjearPuntos',{...mutation(),billId:opened2.billId,expectedBillRevision:opened2.bill.revision,customerId:cid,rewardId:reward.id});assert.equal(redeem.status,'applied')
    await pay(opened2.billId)
    await esperar(()=>root.collection('loyaltyMovements').doc(core.loyaltyMovementId.earn(opened2.billId)).get(),'puntos segunda visita',s=>s.exists)
    await call('cambiarEstadoMesa',{...scope,sessionId:visit2.sessionId,status:'closed'})
    const refund=await call('devolverCobro',{...mutation(),paymentId:paid.paymentId,amountCents:1000,reason:'Devolución parcial de la visita de integración'})
    const reversal=await esperar(()=>root.collection('loyaltyMovements').doc(core.loyaltyMovementId.earnReversal(refund.refundId)).get(),'puntos devueltos',s=>s.exists)
    assert.ok(reversal.get('points')<0)
    resultado.fidelizacion={earned:earned.get('points'),redeemed:redeem.points,refundPoints:reversal.get('points'),stampsAfterSeatedAndPaid:1,promotionDiscountCents:bill1.adjustments.reduce((s,a)=>s+a.amountCents,0)}
    // Solo el cliente que aceptó recibe campaña. Dos controles prueban la exclusión por canal.
    for(let n=0;n<2;n++)await root.collection('customers').doc(`control-${now}-${n}`).set({name:'Control sin permiso',phone:`+34697${String(now+n).slice(-6)}`,email:`control-${now}-${n}@lumbre.test`,language:'es',visits:0,noShows:0,cancellations:0,lastVisitAt:null,notes:'',allergies:'',tags:[`integracion-${now}`],updatedBy:'lumbre-propietario'})
    await call('guardarConfiguracionMarketing',{restaurantId:rid,requestId:randomUUID(),settings:{...core.defaultMarketingSettings('Lumbre'),minHoursBetween:24,maxPer30Days:8,sendWindow:{from:'00:00',to:'23:59'}}})
    console.log('Paso: campana')
    const simulation=await call('simularCampana',{restaurantId:rid,campaignId:campaign.campaignId});assert.equal(simulation.recipients,1);assert.equal(simulation.excluded.no_consent,2)
    await call('lanzarCampana',{restaurantId:rid,requestId:randomUUID(),campaignId:campaign.campaignId,expectedRevision:campaign.revision,at:null})
    const {processCampaigns}=await import('../functions/src/fase5/marketing')
    await processCampaigns(rid)
    const message=(await root.collection('messages').where('campaignId','==',campaign.campaignId).get()).docs[0]!
    await esperar(()=>message.ref.get(),'campaña capturada',s=>s.get('status')==='captured')
    const unsubscribeUrl=String(message.get('data.unsubscribeUrl'))
    // Un envío programado al mismo cliente representa lo que debe cancelarse al retirar permiso.
    const pending=root.collection('messages').doc(`pending-${now}`)
    await pending.set({...core.messageForWrite(core.MessageSchema.parse(message.data()),Timestamp.fromMillis),status:'queued',sendAt:Timestamp.fromMillis(Date.now()+3600000),createdAt:Timestamp.now(),updatedAt:Timestamp.now()})
    await guest.goto(unsubscribeUrl.replace("http://127.0.0.1:3012",WEB))
    await guest.getByRole('button',{name:/Dar.*baja|Confirmar baja|No quiero/}).click()
    await guest.getByText(/baja.*registrada|No recibirás|Has retirado|permiso.*retirado/i).first().waitFor()
    assert.equal((await pending.get()).get('status'),'cancelled')
    await screenshot(guest,'05-baja-movil','Baja desde el enlace del mensaje real capturado y cancelación del envío pendiente.')
    resultado.marketing={recipients:simulation.recipients,excludedWithoutConsent:simulation.excluded.no_consent,captured:1,pendingCancelled:true}
    console.log('Paso: informes')
    const origin=await call('informeOrigen',{restaurantId:rid,from:today,to:today,locationIds:[lid]});assert.ok(origin.rows.some(r=>r.campaignId===campaign.campaignId&&r.reservations===1))
    const panel=await call('panelAnalisis',{restaurantId:rid,from:today,to:today,locationIds:[lid],compare:'previous',slotMinutes:60});assert.ok(panel.total.grossSalesCents>0);assert.ok(panel.margin)
    resultado.analisis={grossSalesCents:panel.total.grossSalesCents,margin:panel.margin,comparison:panel.comparison,origin:origin.rows.filter(r=>r.campaignId===campaign.campaignId)}
    await owner.goto(`${WEB}/panel/campanas/origen`);await owner.getByLabel('Desde el día').fill(today);await owner.getByLabel('Hasta el día').fill(today);await owner.getByRole('button',{name:'Ver informe'}).click();await owner.getByText('Campaña de Llenamos',{exact:false}).first().waitFor();await screenshot(owner,'06-informe-origen','Informe de origen real de reservas y ventas de la campaña.')
    await owner.goto(`${WEB}/panel/analisis`);await owner.getByText('Ventas brutas',{exact:true}).first().waitFor();await screenshot(owner,'07-ventas-comparativa-margen','Panel de ventas con comparativa y margen, sobre cuentas y costes históricos reales del emulador.')
    const forecast=await call('previsionOcupacion',{...scope,from:core.sumarDias(today,1),days:7});assert.equal(forecast.days.length,7);assert.ok(forecast.days.some(d=>d.samples>0));resultado.forecast=forecast.days
    await owner.goto(`${WEB}/panel/analisis?vista=prevision`);await owner.getByText(/semanas/i).first().waitFor();await screenshot(owner,'08-prevision','Previsión con muestras de doce semanas del seed de fase 5.')
    const ownerUser=await auth.getUserByEmail('propietario@lumbre.test')
    const {defaultAnalytics}=await import('../functions/src/fase5/analisis'),{sendDailySummary,aggregateDay,evaluateAutomations}=await import('../functions/src/fase5/procesos')
    await call('guardarConfiguracionAnalisis',{restaurantId:rid,requestId:randomUUID(),settings:{...defaultAnalytics(),dailySummary:{enabled:true,hour:'00:00',channels:['email'],recipientUids:[ownerUser.uid],covers:'previous'}}})
    await aggregateDay(rid,lid,core.sumarDias(today,-1));await sendDailySummary(rid)
    await esperar(()=>root.collection('messages').doc(core.dailySummaryMessageId(core.sumarDias(today,-1),ownerUser.uid,'email')).get(),'resumen capturado',s=>s.get('status')==='captured')
    await owner.goto(`${WEB}/panel/analisis?vista=resumen`);await owner.getByRole('button',{name:'Buscar último disponible'}).click();await owner.getByText(/Capturado en el emulador/).first().waitFor();await screenshot(owner,'09-resumen-diario','Resumen diario preparado por el trabajador real y capturado sin envío externo.')
    const automation=await call('guardarAutomatizacion',{restaurantId:rid,requestId:randomUUID(),ruleId:null,expectedRevision:null,rule:{name:'Revisar señal tras no presentarse',enabled:true,event:'reservation.no_show',conditions:{all:[]},recommendation:{kind:'require_deposit',note:'Valorar pedir señal en la próxima reserva',segmentId:null},cooldownMinutes:0,locationIds:[lid]}})
    const noShow=await call('crearReserva',{...scope,date:today,time:'00:00',partySize:2,guestName:'No presentado de integración',phone:`+34696${String(now).slice(-6)}`,source:'phone'})
    await call('cambiarEstadoReserva',{...scope,reservationId:noShow.reservationId,status:'no_show'})
    await esperar(()=>root.collection('automationEvents').where('type','==','reservation.no_show').get(),'evento no presentado',s=>!s.empty)
    await evaluateAutomations(rid)
    const recommendations=await root.collection('recommendations').where('ruleId','==',automation.ruleId).get();assert.ok(!recommendations.empty)
    await owner.goto(`${WEB}/panel/analisis?vista=reglas`);await owner.getByText('Valorar pedir señal en la próxima reserva').first().waitFor();await screenshot(owner,'10-recomendacion','Automatización que recomienda pedir señal y no ejecuta ninguna acción.')
    await call('resolverRecomendacion',{restaurantId:rid,requestId:randomUUID(),recommendationId:recommendations.docs[0]!.id,decision:'dismissed',note:'Recorrido de integración, se descarta'})
    assert.equal((await recommendations.docs[0]!.ref.get()).get('status'),'dismissed')
    resultado.automation={recommendation:'dismissed',executed:false}
    // Menú real con cinco sesiones independientes y el plan sala, sin cambiar permisos de prueba.
    console.log('Paso: menus')
    const menu:Record<string,string[]>={}
    for(const role of ['propietario','encargada','camarero','cocina','barra']) {
      const s=await session(browser,`${role}@lumbre.test`);contexts.push(s.context)
      await s.page.getByRole('link',{name:'Inicio',exact:true}).first().waitFor()
      const links=await s.page.locator('aside a, [data-slot="sidebar"] a').evaluateAll(as=>as.map(a=>a.getAttribute('href')??''))
      menu[role]=['/panel/fidelizacion','/panel/campanas','/panel/analisis'].filter(href=>links.includes(href))
      assert.equal(menu[role]!.length,['propietario','encargada'].includes(role)?3:0)
      if (menu[role]!.length) await s.page.getByRole('link',{name:'Análisis',exact:true}).scrollIntoViewIfNeeded()
      await screenshot(s.page,`11-menu-${role}`,`Menú real de ${role} con el plan completo.`)
      await s.context.close()
    }
    const restaurantBefore=(await root.get()).data()!
    await root.update({plan:'sala',activeModules:core.activeModulesFor('sala'),updatedBy:'lumbre-propietario'})
    await owner.goto(`${WEB}/panel`);await owner.getByRole('link',{name:'Inicio',exact:true}).first().waitFor()
    for(const title of ['Fidelización','Campañas','Análisis'])assert.equal(await owner.getByRole('link',{name:title,exact:true}).count(),0)
    await screenshot(owner,'12-menu-plan-sala','Plan sala sin entradas de la fase 5.')
    await root.update({plan:restaurantBefore.plan,activeModules:restaurantBefore.activeModules,updatedBy:'lumbre-propietario'})
    resultado.menu={...menu,sala:[]}
    // Inventario integral y borrado con identidad comprobada en el procedimiento local.
    console.log('Paso: privacidad')
    const evidenceId=`evidence-${now}`
    await root.collection('privacyEvidence').doc(evidenceId).set({customerId:cid,verified:true,method:'in_person',expiresAt:Timestamp.fromMillis(Date.now()+3600000),updatedBy:'lumbre-propietario'})
    const privacy=await call('solicitarPrivacidad',{restaurantId:rid,requestId:randomUUID(),customerId:cid,kind:'erase',reason:'Supresión solicitada en el recorrido local'})
    await call('verificarSolicitudPrivacidad',{restaurantId:rid,requestId:randomUUID(),jobId:privacy.jobId,evidenceId})
    const {processPrivacyJobs}=await import('../functions/src/fase6-privacy/worker')
    await processPrivacyJobs(rid)
    const job=await root.collection('privacyJobs').doc(privacy.jobId).get();assert.equal(job.get('status'),'completed',JSON.stringify(job.data()))
    assert.equal((await root.collection('loyaltyAccounts').doc(cid).get()).get('status'),'closed')
    assert.equal((await root.collection('repiteCards').doc(cid).get()).exists,false)
    const removal=await root.collection('repiteOutbox').where('kind','==','remove_card').get();assert.ok(!removal.empty)
    const ownRemoval=removal.docs.find(d=>d.id===core.repiteOperationId.remove(core.sha256Hex(`${rid}:${cid}`).slice(0,20)))
    assert.ok(ownRemoval);assert.ok(ownRemoval.get('result.cardId')||ownRemoval.get('status')==='done')
    resultado.privacy={status:job.get('status'),loyalty:'closed',repiteLinkDeleted:true,removalQueued:true}
    await owner.goto(`${WEB}/panel/privacidad`);await owner.getByText(/Terminada|Completada|completed/i).first().waitFor();await screenshot(owner,'13-privacidad','Solicitud de privacidad completada, cuenta de puntos cerrada y borrado Repite encolado.')
    // Capturas reales adaptadas, sin fixtures de sustitución.
    await owner.goto(`${WEB}/panel/fidelizacion`);await owner.getByText('Cómo se ganan los puntos',{exact:true}).first().waitFor();await screenshot(owner,'14-fidelizacion-escritorio','Programa y premios con datos del servidor.')
    await owner.setViewportSize({width:1180,height:820});await owner.goto(`${WEB}/panel/analisis`);await owner.getByText('Ventas brutas',{exact:true}).first().waitFor();await screenshot(owner,'15-analisis-tableta','Análisis a 1180 × 820, capturado a 2x.')
    await owner.setViewportSize({width:390,height:844});await owner.goto(`${WEB}/panel/campanas`);await owner.getByText(`Recorrido ${now}`,{exact:true}).first().waitFor();await screenshot(owner,'16-campanas-movil','Campañas reales en móvil, sin datos de ejemplo por defecto.')
    const widget = await session(browser,undefined,{width:1180,height:820});contexts.push(widget.context)
    // Solo el contenedor es un fixture; widget.js, iframe y respuestas de reserva son los del producto.
    await widget.page.route(`${WEB}/fase5-contenedor**`, route => route.fulfill({contentType:'text/html',body:`<html lang="es"><body style="margin:0;background:#131209"><script src="${WEB}/widget.js" data-llenamos-slug="${slug}" data-mode="incrustado"></script></body></html>`}))
    await widget.page.goto(`${WEB}/fase5-contenedor?llc=${campaign.campaignId}&utm_source=llenamos&utm_medium=whatsapp`)
    const embedded = widget.page.frameLocator('iframe')
    await embedded.getByRole('radio',{name:/^\d{2}:\d{2}$/}).first().click({timeout:60000})
    await embedded.getByRole('button',{name:'Continuar',exact:true}).click()
    const widgetPhone=`+34695${String(now).slice(-6)}`,widgetCid=core.customerIdFor(rid,widgetPhone)
    await embedded.locator('[data-campo="name"]').fill('Cliente del widget de integración')
    await embedded.locator('[data-campo="phone"]').fill(widgetPhone)
    assert.equal(await embedded.getByRole('checkbox',{name:'Quiero recibir novedades y ofertas por WhatsApp.'}).isChecked(),false)
    await embedded.getByRole('checkbox',{name:'Quiero recibir novedades y ofertas por WhatsApp.'}).check()
    await embedded.locator('#reserva-acceptPolicy').check()
    await screenshot(widget.page,'17-widget-tableta','Widget real montado con widget.js en un contenedor de prueba, permiso opcional desmarcado inicialmente y atribución del padre.')
    const widgetResponse=widget.page.waitForResponse(r=>r.url().endsWith('/crearReservaPublica'))
    await embedded.getByRole('button',{name:/Confirmar reserva|Reservar mesa/}).click()
    const widgetBody=await (await widgetResponse).json();assert.ok(!widgetBody.error,JSON.stringify(widgetBody))
    const widgetReservation=(await local.collection('reservations').where('reference','==',widgetBody.result.reference).get()).docs[0]!
    assert.equal(widgetReservation.get('source'),'widget')
    const widgetOrigin=(await local.collection('reservationOrigins').doc(widgetReservation.id).get()).data()!
    assert.equal(widgetOrigin.campaignId,campaign.campaignId);assert.equal(widgetOrigin.embedHost,'localhost')
    const widgetConsent=(await root.collection('consents').where('customerId','==',widgetCid).get()).docs
    assert.equal(widgetConsent.length,1);assert.equal(widgetConsent[0]!.get('purpose'),'marketing_whatsapp')
    await call('cambiarEstadoReserva',{...scope,reservationId:widgetReservation.id,status:'cancelled'})
    resultado.widget={source:'widget',campaignOrigin:true,parentHost:'localhost',whatsappConsent:true}
    resultado.estado='completado';console.log(JSON.stringify(resultado,null,2))
  } finally {
    writeFileSync(`${OUT}/resultado.json`,JSON.stringify(resultado,null,2)+'\n')
    writeFileSync(`${OUT}/README.md`, `# Integración local de fase 5\n\n2026-11-10. Chromium, capturas a 2x. Proyecto demo-llenamos, fila 2: Auth 9103, Firestore 8097, Functions 5013, Storage 9213 y web 3012. Repite usa su doble HTTP local. Sin pagos ni mensajes externos.\n\nRecorrido: la reserva y la baja se hacen con la interfaz pública; las operaciones de personal usan las callables HTTP reales desde Chromium. Las pantallas se capturan con su sesión y datos reales, sin interceptar respuestas de Firebase ni del producto. Solo el contenedor HTML del widget es un fixture. Los datos auxiliares y las doce semanas del seed están identificados como demostración.\n\n${capturas.map(c=>`- [${c.archivo}](${c.archivo}): ${c.descripcion}`).join('\n')}\n\nPreparación: [backend y emuladores](../../../../functions/src/fase5/README.md). Comprobaciones del cierre: [COMPROBACIONES.md](COMPROBACIONES.md).\n\nResultado de las aserciones: [resultado.json](resultado.json). Script: [fase5-navegador-integracion.ts](../../../../scripts/fase5-navegador-integracion.ts). Ejecutar tras los seeds mediante \`pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/fase5-navegador-integracion.ts\`. Los procesos programados se invocan con su mismo trabajador local; los sellos, puntos, devolución y mensajes usan los disparadores reales de Functions.\n`)
    await Promise.allSettled(contexts.map(c=>c.close()));await browser.close();await db.terminate()
  }
}
main().catch(error=>{console.error(error);process.exitCode=1})
