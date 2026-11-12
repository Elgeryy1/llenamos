// Recorrido real local HTTP, cola y puente con servidor TCP falso. Nunca impresora física.
import { strict as assert } from 'node:assert'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID, createHash } from 'node:crypto'
import { initializeApp, getApps } from 'firebase-admin/app'
import { getFirestore, Timestamp } from 'firebase-admin/firestore'
import { encodeEscPos, prebillPrintDocument, invoicePrintDocument, createTestFiscalProvider, drawerPulse, paymentForWrite, type CallableOutput } from '../packages/core/src/index'
import { testInvoice, testFiscalRecord } from '../packages/core/src/caja/datos-prueba'
import { qrMatrix } from '../functions/src/fase3-print/qr'

async function main() {
if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8096' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9102') throw new Error('Usa exclusivamente los emuladores de la fila 1.')
if (!getApps().length) initializeApp({ projectId:'demo-llenamos' })
const db = getFirestore(), rid='demo-lumbre', lid='centro', path=`restaurants/${rid}/locations/${lid}`
const login = await fetch('http://127.0.0.1:9102/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-local', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'propietario@lumbre.test',password:'Llenamos2026!',returnSecureToken:true}) })
const credentials = await login.json() as { idToken:string }
assert.ok(credentials.idToken,'El seed debe crear la cuenta de Marta.')
const api = async <T>(name:string,data:object,auth=true):Promise<T> => {
  const response = await fetch(`http://127.0.0.1:5012/demo-llenamos/europe-west1/${name}`,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:`Bearer ${credentials.idToken}`}:{})},body:JSON.stringify({data})})
  const body = await response.json() as {result:T;error?:{message:string}}
  assert.ok(response.ok && !body.error,body.error?.message ?? `Error HTTP ${response.status}`)
  return body.result
}
await db.doc(`restaurants/${rid}`).update({plan:'completo',activeModules:['reservations','floor','kitchen','pos']})
const staff=()=>({restaurantId:rid,locationId:lid,requestId:randomUUID()})
const bridgeId='prueba-tcp', { token }=await api<CallableOutput<'vincularPuente'>>('vincularPuente',{...staff(),bridgeId})
// No deja otra caja activa que haga ambigua la asignación.
const previous=await db.collection(`${path}/printers`).get()
for(const p of previous.docs) await p.ref.update({active:false})
const printer={name:'Térmica TCP de prueba',bridgeId,paperMm:80 as const,columns:48 as const,stationIds:['cocina','barra'],tickets:true,drawer:true,active:true}
// Se resuelven las estaciones reales del seed, nunca se inventan referencias activas.
const stations=await db.collection(`${path}/stations`).get()
printer.stationIds=stations.docs.filter(s=>s.get('active')).map(s=>s.id)
const {printerId}=await api<CallableOutput<'guardarImpresora'>>('guardarImpresora',{...staff(),printerId:null,printer})
const dir=await mkdtemp(join(tmpdir(),'llenamos-print-e2e-')), config=join(dir,'config.json'), captures:Buffer[]=[]
const server=createServer({allowHalfOpen:true},socket=>{const chunks:Buffer[]=[];socket.on('data',b=>chunks.push(b));socket.on('end',async()=>{const bytes=Buffer.concat(chunks);captures.push(bytes);await writeFile(join(dir,`tcp-${captures.length}.bin`),bytes);socket.end()})})
await new Promise<void>(r=>server.listen(9100,'127.0.0.1',r))
await writeFile(config,JSON.stringify({functionsUrl:'http://127.0.0.1:5012/demo-llenamos/europe-west1',restaurantId:rid,locationId:lid,bridgeId,token,printers:{[printerId]:{host:'127.0.0.1',port:9100}},journalDir:'diario'}),{mode:0o600})
const runBridge=()=>new Promise<void>((resolveRun,reject)=>{const child=spawn(process.execPath,[resolve('tools/print-bridge/bridge.mjs'),config,'--once'],{stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=String(b));child.stderr.on('data',b=>output+=String(b));child.on('error',reject);child.on('exit',code=>code===0?resolveRun():reject(new Error(output)))})
async function print(kind:string,sourceId:string,expected:Uint8Array,copy=false){
 const result=await api<CallableOutput<'solicitarImpresion'>>('solicitarImpresion',{...staff(),printerId,kind,sourceId,copy})
 assert.equal(result.status,'queued');const before=captures.length
 await runBridge();assert.equal(captures.length,before+1)
 assert.deepEqual(captures.at(-1),Buffer.from(expected))
 assert.deepEqual(await readFile(join(dir,`tcp-${captures.length}.bin`)),Buffer.from(expected))
 assert.equal((await db.doc(`${path}/printStatuses/${result.printJobId}`).get()).get('status'),'printed')
 console.log(`${kind}${copy?' copia':''}: bytes exactos y confirmación del puente verificados.`)
 return result.printJobId
}
try{
 const testDoc=prebillPrintDocument(['Prueba de impresora','Llenamos · impresión local','Papel térmico y acentos: á é í ó ú ñ €','No es una venta. No abre el cajón.'])
 await print('test',printerId,encodeEscPos(testDoc,printer))
 const small={...printer,paperMm:58 as const,columns:32 as const}
 await api('guardarImpresora',{...staff(),printerId,printer:small})
 await print('test',printerId,encodeEscPos(testDoc,small))
 await api('guardarImpresora',{...staff(),printerId,printer})
 const invoiceId=`prueba-tcp-${randomUUID()}`,recordId=`prueba-tcp-${randomUUID()}`,record=testFiscalRecord(),invoice=testInvoice()
 const artifact=createTestFiscalProvider().prepare({regime:'verifactu',record,ticketbaiPrevious:null});const {record:_,...stored}=artifact
 await db.doc(`${path}/invoices/${invoiceId}`).create({...invoice,recordId,createdAt:Timestamp.now(),updatedBy:'lumbre-propietario'})
 await db.doc(`restaurants/${rid}/fiscalRecords/${recordId}`).create({...stored,locationId:lid,invoiceId})
 const fiscal={qrUrl:artifact.qrUrl!,legend:artifact.legend,warning:artifact.warning}
 await print('invoice',invoiceId,encodeEscPos(invoicePrintDocument(invoice,fiscal),printer,qrMatrix))
 await print('invoice',invoiceId,encodeEscPos(invoicePrintDocument(invoice,fiscal,true),printer,qrMatrix),true)
 const payId=`prueba-tcp-${randomUUID()}`
 await db.doc(`${path}/payments/${payId}`).create(paymentForWrite({billId:'prueba',partId:'prueba',cashSessionId:'prueba',kind:'charge',originalPaymentId:null,method:'cash',status:'succeeded',amountCents:100,tipCents:0,tenderedCents:100,changeCents:0,externalId:null,requestId:randomUUID(),reason:null,at:Date.now(),by:'lumbre-propietario'},Timestamp.fromMillis))
 await print('drawer',payId,drawerPulse())
 await runBridge();assert.equal(captures.length,5,'El trabajo confirmado no vuelve a enviarse.')
 console.log(`Recorrido local verificado. Impresora del panel: ${printerId}. No se ha impreso en hardware real.`)
}finally{await new Promise<void>(r=>server.close(()=>r()));await rm(dir,{recursive:true,force:true})}

}
main().catch(error => { console.error(error instanceof Error ? error.message : "No se pudo completar la prueba local."); process.exitCode = 1 })
