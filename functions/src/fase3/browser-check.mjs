// Prueba local por HTTP desde Chromium. No sustituye la pantalla de caja de la otra fila.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { initializeApp } from 'firebase-admin/app'
import { getFirestore } from 'firebase-admin/firestore'

if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8098' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9104') throw new Error('Esta prueba exige los emuladores de la fila 3.')
const require = createRequire(import.meta.url)
let playwright
try { playwright = require('playwright') }
catch { playwright = require('/srv/LogiQD/llenamos/.claude/pw/node_modules/playwright') }
initializeApp({ projectId:'demo-llenamos' })
const db = getFirestore(), tableId = `prueba-caja-${Date.now()}`
const local = db.doc('restaurants/demo-lumbre/locations/centro')
const cashSessionId = (await local.collection('registerLocks').doc('principal').get()).get('cashSessionId')
if (!cashSessionId) throw new Error('Ejecuta primero el seed de caja.')
await local.collection('tables').doc(tableId).set({ name:'Prueba caja',areaId:'sala',seats:4,shape:'rect',x:10,y:10,w:14,h:22,joinableWith:[],enabled:true,updatedBy:null })
const output = new URL('../../../docs/diseno/capturas/caja-backend/',import.meta.url)
await mkdir(output,{ recursive:true })
const browser = await playwright.chromium.launch({ executablePath:'/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome',headless:true,args:['--no-sandbox'] })
let page
try {
  page = await browser.newPage({ viewport:{ width:1440,height:900 },deviceScaleFactor:2 })
  await page.goto('http://localhost:3013/entrar')
  await page.getByLabel('Correo',{ exact:true }).fill('propietario@lumbre.test')
  await page.getByLabel('Contraseña',{ exact:true }).fill('Llenamos2026!')
  await page.getByRole('button',{ name:'Entrar',exact:true }).click()
  await page.waitForURL('**/panel',{ timeout:60000 })
  const setup = await page.evaluate(async tableId => {
    const auth = await fetch('http://127.0.0.1:9104/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key',{ method:'POST',headers:{ 'Content-Type':'application/json' },body:JSON.stringify({ email:'propietario@lumbre.test',password:'Llenamos2026!',returnSecureToken:true }) }).then(r => r.json())
    const scope = { restaurantId:'demo-lumbre',locationId:'centro' }, evidence = []
    const call = async (name,data) => {
      const response = await fetch(`http://127.0.0.1:5014/demo-llenamos/europe-west1/${name}`,{ method:'POST',headers:{ 'Content-Type':'application/json',Authorization:`Bearer ${auth.idToken}` },body:JSON.stringify({ data }) })
      const result = await response.json()
      evidence.push({ operation:name,status:response.status,result:result.result ?? result.error })
      if (!response.ok || result.error) throw new Error(JSON.stringify(result.error))
      return result.result
    }
    const mutation = () => ({ ...scope,requestId:crypto.randomUUID() })
    const opened = await call('abrirMesa',{ ...scope,tableIds:[tableId],guests:2 })
    const order = await call('enviarPedido',{ ...scope,sessionId:opened.sessionId,lines:[{ kind:'item',itemId:'bravas',quantity:2 }] })
    if (order.status !== 'sent') throw new Error('El pedido no se ha aceptado.')
    const account = await call('abrirCuenta',{ ...mutation(),target:{ kind:'session',id:opened.sessionId } })
    const lineId = account.bill.lines[0].lineId
    const adjusted = await call('ajustarCuenta',{ ...mutation(),billId:account.billId,expectedRevision:account.bill.revision,lineId,kind:'invitation',amountCents:50,reason:'Invitación de prueba local' })
    const voided = await call('ajustarCuenta',{ ...mutation(),billId:account.billId,expectedRevision:adjusted.revision,lineId,kind:'void',amountCents:25,reason:'Corrección de prueba local' })
    const equal = await call('dividirCuenta',{ ...mutation(),billId:account.billId,expectedRevision:voided.revision,split:{ kind:'equal',parts:3 } })
    const dishes = await call('dividirCuenta',{ ...mutation(),billId:account.billId,expectedRevision:equal.revision,split:{ kind:'dishes',lineIds:[order.lineIds] } })
    const amounts = await call('dividirCuenta',{ ...mutation(),billId:account.billId,expectedRevision:dishes.revision,split:{ kind:'amount',amountsCents:[500,voided.totalCents - 500] } })
    const locked = await call('prepararCobro',{ ...mutation(),billId:account.billId,expectedRevision:amounts.revision })
    await call('cambiarEstadoLineas',{ ...scope,lineIds:order.lineIds,status:'served' })
    return { idToken:auth.idToken,evidence,scope,opened,account,amounts,locked }
  },tableId)
  await page.addInitScript(({ setup,cashSessionId }) => {
    const state = { ...setup,cashSessionId }
    state.call = async (name,data) => {
      const response = await fetch(`http://127.0.0.1:5014/demo-llenamos/europe-west1/${name}`,{ method:'POST',headers:{ 'Content-Type':'application/json',Authorization:`Bearer ${setup.idToken}` },body:JSON.stringify({ data }) })
      const result = await response.json()
      state.evidence.push({ operation:name,status:response.status,result:result.result ?? result.error })
      if (!response.ok || result.error) throw new Error(JSON.stringify(result.error))
      return result.result
    }
    state.mutation = () => ({ ...state.scope,requestId:crypto.randomUUID() })
    window.__cajaBackend = state
  },{ setup,cashSessionId })
  await page.goto(`http://localhost:3013/panel/comandero?s=${setup.opened.sessionId}`)
  await page.getByText('Gestionar Prueba caja',{ exact:true }).click()
  const closeResponse = page.waitForResponse(r => r.url().endsWith('/cambiarEstadoMesa') && r.request().method() === 'POST')
  await page.getByRole('button',{ name:'Cerrar mesa',exact:true }).click()
  const blocked = await (await closeResponse).json()
  assert.equal(blocked.error?.message,'Salda la cuenta antes de cerrar la mesa.')
  await page.getByText(/^Salda la cuenta antes de cerrar la mesa\./).waitFor()
  await page.evaluate(() => window.scrollTo(0,0))
  await page.screenshot({ path:new URL('01-cierre-bloqueado.png',output).pathname })
  const outcome = await page.evaluate(async () => {
    const { call,mutation,scope,account,amounts,locked,cashSessionId,evidence } = window.__cajaBackend
    const part = { billId:account.billId,expectedRevision:locked.revision,partId:amounts.parts[0].id }
    const cashInput = { ...mutation(),...part,cashSessionId,method:'cash',amountCents:200,tipCents:50,tenderedCents:500 }
    const payment = await call('registrarCobro',cashInput), retry = await call('registrarCobro',cashInput)
    if (JSON.stringify(payment) !== JSON.stringify(retry)) throw new Error('Se ha duplicado el cobro al reintentar.')
    await call('registrarCobro',{ ...mutation(),...part,cashSessionId,method:'card',amountCents:300,terminalReference:'Registro manual de datáfono de prueba' })
    const rest = amounts.parts[1]
    const competing = await Promise.allSettled([1,2].map(() => call('registrarCobro',{ ...mutation(),...part,partId:rest.id,cashSessionId,method:'cash',amountCents:rest.totalCents,tenderedCents:rest.totalCents })))
    if (competing.filter(r => r.status === 'fulfilled').length !== 1) throw new Error('Los cobros competidores no han respetado el saldo.')
    const simplified = await call('emitirFactura',{ ...mutation(),...part,type:'F2',recipient:null })
    const complete = await call('emitirFactura',{ ...mutation(),...part,partId:rest.id,type:'F1',recipient:{ name:'Cliente de prueba',address:'Domicilio inventado para prueba local',identity:{ kind:'nif',nif:'89890001K' } } })
    if (simplified.warning !== 'no válido para Hacienda' || complete.warning !== simplified.warning) throw new Error('Falta la advertencia fiscal.')
    const refund = await call('devolverCobro',{ ...mutation(),paymentId:payment.paymentId,amountCents:100,reason:'Devolución parcial de prueba' })
    const rectification = await call('rectificarFactura',{ ...mutation(),invoiceId:simplified.invoiceId,type:'R5',mode:'I',reason:'Devolución parcial de prueba',reductions:[{ lineIndex:0,amountCents:100 }] })
    await call('registrarMovimientoCaja',{ ...mutation(),cashSessionId,kind:'in',amountCents:300,reason:'Fondo adicional de prueba' })
    await call('registrarMovimientoCaja',{ ...mutation(),cashSessionId,kind:'out',amountCents:200,reason:'Retirada de prueba' })
    const view = await call('verCuenta',{ ...scope,billId:account.billId })
    const countedCents = 10000 + 200 + 50 + rest.totalCents - 100 + 300 - 200
    const closed = await call('cerrarCaja',{ ...mutation(),cashSessionId,countedCents,reason:null })
    const tips = await call('repartirPropinas',{ ...mutation(),cashSessionId,hours:[{ uid:'lumbre-propietario',minutes:60 },{ uid:'lumbre-camarero',minutes:120 }] })
    return { at:new Date().toISOString(),warning:simplified.warning,billStatus:view.bill.status,totalCents:view.bill.totalCents,paidCents:view.bill.paidCents,refundedCents:view.bill.refundedCents,changeCents:payment.changeCents,competing:competing.map(r => r.status),cash:closed.cashSession,refundStatus:refund.status,invoiceNumbers:[simplified.number,complete.number,rectification.number],tips:tips.shares,evidence }
  })
  assert.equal(outcome.billStatus,'settled')
  assert.equal(outcome.cash.differenceCents,0)
  assert.equal(outcome.changeCents,250)
  assert.equal(outcome.refundStatus,'succeeded')
  assert.equal(outcome.tips.reduce((sum,s) => sum + s.amountCents,0),50)
  await writeFile(new URL('recorrido-http.json',output),JSON.stringify(outcome,null,2)+'\n')
  const paidCloseResponse = page.waitForResponse(r => r.url().endsWith('/cambiarEstadoMesa') && r.request().method() === 'POST')
  await page.getByRole('button',{ name:'Cerrar mesa',exact:true }).click()
  assert.equal((await (await paidCloseResponse).json()).result?.status,'closed')
  const management = page.locator('details').filter({ has:page.getByText('Gestionar Prueba caja',{ exact:true }) })
  if (await management.getAttribute('open') === null) await page.getByText('Gestionar Prueba caja',{ exact:true }).click()
  await page.getByRole('button',{ name:'Reabrir mesa',exact:true }).waitFor()
  await page.evaluate(() => window.scrollTo(0,0))
  await page.screenshot({ path:new URL('02-cierre-tras-cobro.png',output).pathname })
  await page.setViewportSize({ width:390,height:844 })
  await page.evaluate(() => window.scrollTo(0,0))
  await page.screenshot({ path:new URL('03-cierre-movil.png',output).pathname })
  console.log(JSON.stringify({ billStatus:outcome.billStatus,httpCalls:outcome.evidence.length,competing:outcome.competing,cashDifference:outcome.cash.differenceCents,warning:outcome.warning }))
} catch (error) {
  if (page) {
    console.error((await page.locator('body').innerText()).slice(-2200))
    await page.screenshot({ path:'/tmp/f3-browser-error.png',fullPage:true })
  }
  throw error
} finally {
  await browser.close()
}
