import type * as Core from '../packages/core/src/index'
/** Recorrido del navegador con Auth y callables HTTP reales; no modifica la web del producto. */
import { mkdirSync,writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { entorno } from './fase5-entorno'
async function main() {
  entorno()
  const require=createRequire(import.meta.url)
  let playwright:typeof import('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright')
  try { playwright=require('playwright') } catch { playwright=require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
  const core=await import('../packages/core/src/index'),{ db }=await import('../functions/src/shared'),{ ts }=await import('../functions/src/fase5/context')
  const rid='demo-lumbre',root=db.doc(`restaurants/${rid}`),customerId=core.customerIdFor(rid,'+34699000100')
  const now=Date.now(),id=`fase5-navegador-${now}`,p=`${root.path}/locations/centro`
  await db.doc(`${p}/tableSessions/${id}`).set({status:'open',tableIds:['sala-1'],label:'S1',guests:2,reservationId:id,customerId,guestName:'Ana Prueba',waiterUid:null,waiterName:null,notes:'Visita de prueba del backend',openedAt:ts(now),openedBy:null,closedAt:null,closedBy:null,billRequestedAt:null,mergedInto:null,totalCents:10000,lineCount:1,unservedCount:0,history:[]})
  const b:Core.Bill={target:{kind:'session',id},customerId,status:'open',revision:1,lines:[{lineId:id,parentLineId:null,name:'Cuenta de prueba',quantity:1,grossCents:10000,taxRate:10,guest:null}],adjustments:[],totalCents:10000,paidCents:0,refundedCents:0,openedAt:now,lockedAt:null,settledAt:null}
  await db.doc(`${p}/bills/${id}`).set(core.billForWrite(b,n=>ts(n)))
  const rewards=(await root.collection('loyaltyRewards').get()).docs
  const rewardId=rewards.find(r=>r.get('pointsCost')===80)!.id
  const out='docs/diseno/capturas/fase5-backend';mkdirSync(out,{recursive:true})
  const browser=await playwright.chromium.launch({headless:true,executablePath:'/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',args:['--no-sandbox']})
  try {
    const context=await browser.newContext({viewport:{width:1440,height:1000},deviceScaleFactor:2})
    const page=await context.newPage()
    await page.goto('http://127.0.0.1:3012/entrar')
    await page.getByLabel('Correo').fill('propietario@lumbre.test')
    await page.getByLabel('Contraseña',{exact:true}).fill('Llenamos2026!')
    await page.getByRole('button',{name:'Entrar',exact:true}).click()
    await page.waitForURL('**/panel',{timeout:60000})
    await page.screenshot({path:`${out}/sesion-real.png`,fullPage:true})
    const authResponse=await page.evaluate(async()=>{
      const r=await fetch('http://127.0.0.1:9103/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'propietario@lumbre.test',password:'Llenamos2026!',returnSecureToken:true})});return r.json()
    })
    const token=String(authResponse.idToken)
    const call=async(name:string,data:unknown)=>page.evaluate(async({name,data,token})=>{
      const r=await fetch(`http://127.0.0.1:5013/demo-llenamos/europe-west1/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({data})})
      const value=await r.json();if(value.error) throw new Error(JSON.stringify(value.error));return value.result
    },{name,data,token})
    const scope={restaurantId:rid},requestId=`browser-${now}`
    let before=await call('verCuentaFidelizacion',{...scope,customerId})
    if(before.available<80) {
      await call('ajustarPuntos',{...scope,requestId:`browser-credit-${now}`,customerId,points:120,reason:'Saldo de prueba para repetir el recorrido local del navegador'})
      before=await call('verCuentaFidelizacion',{...scope,customerId})
    }
    const redeem=await call('canjearPuntos',{...scope,locationId:'centro',requestId,customerId,rewardId,billId:id,expectedBillRevision:1})
    const repeated=await call('canjearPuntos',{...scope,locationId:'centro',requestId,customerId,rewardId,billId:id,expectedBillRevision:1})
    if(JSON.stringify(redeem)!==JSON.stringify(repeated)||redeem.status!=='applied') throw new Error('El canje o su idempotencia han fallado.')
    const card=await call('crearTarjetaRepite',{...scope,requestId:`card-${now}`,customerId})
    const preview=await call('previsionOcupacion',{...scope,locationId:'centro',from:core.sumarDias(core.horaLocal(now,'Europe/Madrid').fecha,1),days:7})
    const panel=await call('panelAnalisis',{...scope,from:core.sumarDias(core.horaLocal(now,'Europe/Madrid').fecha,-7),to:core.horaLocal(now,'Europe/Madrid').fecha,locationIds:['centro'],compare:'previous',slotMinutes:60})
    const after=await call('verCuentaFidelizacion',{...scope,customerId})
    const report={before,redeem,repeated,after,card,forecast:preview,panel}
    writeFileSync(`${out}/resultado.json`,JSON.stringify(report,null,2)+'\n')
    // Informe de diagnóstico: los valores proceden de las respuestas HTTP de arriba.
    const html=`<!doctype html><html lang="es"><meta charset="utf-8"><style>body{background:#131209;color:#f4f1ea;font:20px system-ui;padding:48px;line-height:1.6}h1{color:#f0a35e;font-size:36px}section{background:#1f1f1f;border-radius:18px;padding:24px;margin:24px 0}strong{color:#8fc7a0}small{color:#a39f95}p{margin:8px 0}</style><h1>Backend de clientes, marketing y análisis</h1><small>Diagnóstico local de fase 5 · Auth, Firestore y Functions reales de demo</small><section><h2>Canje validado en el servidor</h2><p>Puntos disponibles antes: <strong>${before.available}</strong></p><p>Canje: <strong>${redeem.points} puntos · ${core.formatMoney(redeem.discountCents)}</strong></p><p>Puntos disponibles después: <strong>${after.available}</strong></p><p>Repetir requestId: <strong>mismo resultado, un solo canje</strong></p></section><section><h2>Previsión de la semana</h2>${preview.days.map((d:{date:string;samples:number;confidence:string})=>`<p>${d.date}: <strong>${d.samples} semanas</strong> · confianza ${core.FORECAST_CONFIDENCE_LABEL[d.confidence as Core.ForecastConfidence]}</p>`).join('')}</section><section><h2>Ventas del periodo</h2><p>Ventas brutas: <strong>${core.formatMoney(panel.total.grossSalesCents)}</strong></p><p>Cuentas: <strong>${panel.total.bills}</strong> · comensales: <strong>${panel.total.guests}</strong></p><p>Tarjeta Repite: <strong>${card.status==='queued'?'pendiente en el doble local':card.status}</strong></p></section><small>Esta es evidencia del backend. Las pantallas de producto las integran los otros agentes.</small></html>`
    for(const [label,width,height] of [['escritorio',1440,1100],['tableta',1024,1365],['movil',390,844]] as const) {
      await page.setViewportSize({width,height});await page.setContent(html);await page.screenshot({path:`${out}/backend-${label}.png`,fullPage:true})
    }
    console.log({canje:redeem.status,saldo:after.available,card:card.status,semanas:preview.days.map((d:{samples:number})=>d.samples)})
  } finally {await browser.close();await db.terminate()}
}
main().catch(error=>{console.error(error);process.exitCode=1})
