import { createHmac,timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Pool,PoolClient } from 'pg'
import { z } from 'zod'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { billingError,evaluate,hash,subscriptionOf } from './common.js'
import { billingProvider,type BillingProvider } from './provider.js'
import type { PlatformRoute } from './http.js'

const Id=z.string().min(1).max(200)
const EventSchema=z.object({id:Id,type:z.string(),created:z.number().int().nonnegative(),livemode:z.boolean(),data:z.object({object:z.record(z.string(),z.unknown())})})
const Line=z.object({amount:z.number().int(),currency:z.literal('eur'),quantity:z.number().int().optional(),proration:z.boolean().optional(),period:z.object({start:z.number().int(),end:z.number().int()}),price:z.object({id:Id}).optional(),pricing:z.object({price_details:z.object({price:Id})}).optional()})
const Invoice=z.object({id:Id,customer:Id,subscription:Id.optional(),parent:z.object({subscription_details:z.object({subscription:Id})}).optional(),currency:z.literal('eur'),status:z.string(),paid:z.boolean().optional(),attempt_count:z.number().int().optional(),amount_paid:z.number().int(),amount_due:z.number().int(),total:z.number().int(),lines:z.object({has_more:z.literal(false),data:z.array(Line).min(1).max(20)})})
const SubscriptionObject=z.object({id:Id,customer:Id,status:z.string(),cancel_at_period_end:z.boolean(),items:z.object({data:z.array(z.object({price:z.object({id:Id}),quantity:z.literal(1),current_period_end:z.number().int().optional()})).length(1)}),current_period_end:z.number().int().optional(),latest_invoice:z.unknown().optional()})
const Checkout=z.object({id:Id,mode:z.literal('subscription'),customer:Id,subscription:Id,metadata:z.object({restaurantId:core.DocIdSchema,intentId:z.string().regex(/^[a-f0-9]{64}$/)})})
const ExpiredCheckout=z.object({id:Id,metadata:z.object({restaurantId:core.DocIdSchema,intentId:z.string().regex(/^[a-f0-9]{64}$/)})})
const supported=['checkout.session.completed','checkout.session.expired','invoice.paid','invoice.payment_failed','customer.subscription.updated','customer.subscription.deleted']
const MAX_PERIOD_MS=400*86_400_000

/**
 * La línea que identifica el plan. Una renovación o primera factura tiene una sola línea; con prorrateo (cambio de plan
 * a mitad de periodo) hay líneas extra con `proration`: la principal es la única que no lo es, o, si todas lo son,
 * la positiva de mayor importe (el plan nuevo). Con más de una línea el total se contrasta con la suma de las líneas.
 */
function planLine(invoice:z.infer<typeof Invoice>) {
  const regular=invoice.lines.data.filter(line=>!line.proration)
  if(regular.length>1)throw bad('La factura tiene varias líneas de tarifa.')
  if(regular.length===1)return {line:regular[0]!,exact:invoice.lines.data.length===1,prorated:false}
  const positive=invoice.lines.data.filter(line=>line.amount>0).sort((a,b)=>b.amount-a.amount)[0]
  if(!positive)throw bad('La factura no tiene una línea de tarifa.')
  return {line:positive,exact:false,prorated:true}
}

/** Una transacción por llamada: con un `Pool` abre la suya; en el worker sería `ctx.tenant`. */
export interface Runner {tx<T>(fn:(client:PoolClient)=>Promise<T>):Promise<T>}
export function poolRunner(pool:Pool):Runner {
  return {async tx(fn) {
    const client=await pool.connect()
    try {await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result}
    catch(error){try{await client.query('ROLLBACK')}catch{/* la conexión se descarta al liberar */}throw error}
    finally{client.release()}
  }}
}
const bad=(message:string)=>new ApiError(422,'failed-precondition',message)
const retry=(message:string)=>new ApiError(503,'unavailable',message)

/**
 * Se llama solo con bytes ya verificados con el secreto de la plataforma y con el login `llenamos_webhook` (las
 * funciones `billing_event_*` no se conceden a ningún otro). Idempotente por ID de evento de Stripe: repetir un evento
 * aplicado devuelve `duplicate`; una factura que no cabía en los límites (`blocked_overage`) se reaplica al reenviarla.
 * Un `ApiError` 5xx indica que Stripe debe reintentar.
 */
export async function handleBillingEvent(runner:Runner,body:unknown,options:{provider?:BillingProvider;now?:number}={}):Promise<{status:string}> {
  const provider=options.provider??billingProvider(),now=options.now??Date.now()
  let event=EventSchema.parse(body)
  if(!supported.includes(event.type))return {status:'ignored'}
  // La clave de test y la de producción no se mezclan: un evento de otro modo no toca contratos.
  if(provider.livemode!==undefined&&event.livemode!==provider.livemode)throw bad('El evento pertenece a otro modo de Stripe.')
  const eventHash=hash(event.id),object=event.data.object
  try {
    if((await runner.tx(client=>client.query('SELECT llenamos.billing_event_seen($1) AS seen',[eventHash]))).rows[0].seen)return {status:'duplicate'}
    if(event.type==='checkout.session.completed') {
      const checkout=Checkout.parse(object)
      const status=(await runner.tx(client=>client.query('SELECT llenamos.billing_event_bind($1,$2,$3,$4,$5,$6,$7,$8) AS status',
        [eventHash,event.id,event.created,checkout.metadata.restaurantId,checkout.metadata.intentId,checkout.id,checkout.customer,checkout.subscription]))).rows[0].status as string
      return {status}
    }
    if(event.type==='checkout.session.expired') {
      const expired=ExpiredCheckout.parse(object)
      const status=(await runner.tx(client=>client.query('SELECT llenamos.billing_event_checkout_expired($1,$2,$3,$4,$5,$6) AS status',
        [eventHash,event.id,event.created,expired.metadata.restaurantId,expired.metadata.intentId,expired.id]))).rows[0].status as string
      return {status}
    }
    const invoiceEvent=event.type.startsWith('invoice.')
    const invoice=invoiceEvent?Invoice.parse(object):null,subObject=invoiceEvent?null:SubscriptionObject.parse(object)
    const subscriptionId=invoice?(invoice.subscription??invoice.parent?.subscription_details.subscription):subObject!.id
    const customer=invoice?.customer??subObject!.customer
    if(!subscriptionId)throw bad('Falta el contrato de la factura.')
    const peek=(await runner.tx(client=>client.query('SELECT llenamos.billing_event_peek($1,$2,$3) AS peek',[subscriptionId,customer,eventHash]))).rows[0].peek as {lastBillingCreated:number;blocked:boolean}|null
    if(!peek)throw retry('El contrato todavía no está vinculado. Reintenta el evento.')
    const observed=Number(peek.lastBillingCreated)
    let reconciled:z.infer<typeof SubscriptionObject>|null=null
    // Un evento que quedó bloqueado por exceso de uso se reaplica tal cual: no es un evento desordenado.
    if(event.created<=observed&&!peek.blocked) {
      if(!provider.configured)throw retry('Evento desordenado. Falta consultar el estado vigente de Stripe; no se cambia el acceso.')
      reconciled=SubscriptionObject.parse(await provider.current(subscriptionId))
      if(reconciled.id!==subscriptionId||reconciled.customer!==customer)throw bad('La reconciliación pertenece a otro contrato.')
      if(reconciled.status==='canceled')event={...event,type:'customer.subscription.deleted',data:{object:reconciled}}
      else {
        const latest=Invoice.parse(reconciled.latest_invoice)
        if((latest.subscription??latest.parent?.subscription_details.subscription)!==subscriptionId||latest.customer!==customer)throw bad('La factura vigente no corresponde al contrato.')
        // Una factura en borrador o sin intento de cobro todavía no es un impago.
        if(latest.status==='draft'||(latest.status==='open'&&latest.attempt_count===0))return {status:'ignored'}
        event={...event,type:latest.status==='paid'?'invoice.paid':'invoice.payment_failed',data:{object:latest}}
      }
    }
    return await runner.tx(async client=>{
      const locked=(await client.query('SELECT llenamos.billing_event_lock($1,$2,$3) AS locked',[subscriptionId,customer,eventHash])).rows[0].locked
      if(locked.seen)return {status:'duplicate'}
      const current=subscriptionOf(locked.subscription)
      if(Number(locked.subscription.last_billing_created??-1)!==observed)throw retry('Ha llegado otro evento. Reintenta para reconciliar.')
      const rid=locked.restaurantId as string,usage=locked.usage as Record<string,number>|null
      const plans=(locked.plans as unknown[]).map(definition=>core.PlanDefinitionSchema.parse(definition))
      const previousStatus=current.status
      if(current.status==='cancelled'&&event.type!=='customer.subscription.deleted')throw bad('Un contrato dado de baja no se reactiva con eventos tardíos.')
      let plan=plans.find(p=>p.id===current.planId&&p.version===current.planVersion)
      if(!plan)throw bad('No se encuentra la versión del plan del contrato.')
      let status='applied',paidInvoice:string|null=null,renewalGrace=locked.subscription.renewal_grace===true
      const lastPaid=locked.subscription.last_paid_invoice_id as string|null
      if(event.type.startsWith('invoice.')) {
        const inv=Invoice.parse(event.data.object),{line,exact,prorated}=planLine(inv)
        const priceId=line.price?.id??line.pricing?.price_details.price
        const candidates=plans.flatMap(p=>[
          ...(p.stripeMonthlyPriceId===priceId?[{plan:p,interval:'month' as const,amount:p.monthlyCents}]:[]),
          ...(p.stripeAnnualPriceId===priceId?[{plan:p,interval:'year' as const,amount:p.annualCents}]:[]),
        ])
        if(candidates.length!==1)throw bad('El precio no corresponde a una versión única del catálogo.')
        const match=candidates[0]!
        if(line.period.end<=line.period.start||(line.quantity!==undefined&&line.quantity!==1))throw bad('El periodo o la cantidad de la factura no es válido.')
        const sum=inv.lines.data.reduce((total,l)=>total+l.amount,0)
        if(exact){ if(line.amount!==match.amount||inv.total!==match.amount||inv.amount_due!==match.amount)throw bad('El importe de la factura no coincide con la tarifa.') }
        else {
          // Con prorrateo el importe de la tarifa no es el total: la línea no supera la tarifa y el total cuadra con las líneas.
          if(sum!==inv.total||inv.amount_due!==inv.total||inv.total<0||(prorated?line.amount>match.amount:line.amount!==match.amount))throw bad('El importe de la factura con prorrateo no es coherente con la tarifa.')
        }
        const periodEndsAt=line.period.end*1000
        if(current.periodEndsAt&&periodEndsAt<current.periodEndsAt)throw bad('La factura es anterior al periodo vigente. Se necesita reconciliar.')
        if(event.type==='invoice.paid') {
          if(inv.status!=='paid'||inv.paid===false||inv.amount_paid!==inv.total||periodEndsAt<=now)throw bad('La factura no está pagada por completo o su periodo ha vencido.')
          const used={locations:usage?.locations??0,members:usage?.members??0,apiKeys:usage?.api_keys??0,webhooks:usage?.webhooks??0}
          if(!usage||core.planOverages(match.plan.limits,used).length) {current.status='suspended';status='blocked_overage'}
          else {
            plan=match.plan;current.planId=plan.id;current.planVersion=plan.version;current.interval=match.interval
            current.status='active';current.periodEndsAt=periodEndsAt;current.graceEndsAt=null;renewalGrace=false
            if(reconciled)current.cancelAtPeriodEnd=reconciled.cancel_at_period_end
            paidInvoice=inv.id
          }
        } else {
          if(inv.status==='paid'||inv.amount_paid!==0)throw bad('La factura no representa un impago sin resolver.')
          if(lastPaid===inv.id)throw bad('Esta factura ya está pagada. Se necesita reconciliar.')
          current.status=previousStatus==='suspended'?'suspended':'past_due'
          // El margen de renovación no cuenta como gracia del impago: el primer cobro fallido abre sus siete días.
          if(renewalGrace||!current.graceEndsAt)current.graceEndsAt=now+7*86_400_000
          renewalGrace=false
          if(now>=current.graceEndsAt)current.status='suspended'
        }
      } else {
        const sub=SubscriptionObject.parse(event.data.object),price=sub.items.data[0]!.price.id
        if(price!==plan.stripeMonthlyPriceId&&price!==plan.stripeAnnualPriceId)throw bad('Cambio del portal pendiente de factura y comprobación de cuotas.')
        if(event.type==='customer.subscription.deleted') {
          if(sub.status!=='canceled')throw bad('La baja no está confirmada.')
          current.status='cancelled';current.cancelAtPeriodEnd=false
        } else {
          // Ni status active ni la URL de vuelta sustituyen a una factura pagada: pero Stripe adelanta el periodo al renovar
          // y cobra la factura después, así que un contrato activo sigue su periodo sin cortar el servicio.
          current.cancelAtPeriodEnd=sub.cancel_at_period_end
          const end=(sub.items.data[0]!.current_period_end??sub.current_period_end)
          if(sub.status==='active'&&current.status==='active'&&end&&current.periodEndsAt&&end*1000>current.periodEndsAt&&end*1000-current.periodEndsAt<=MAX_PERIOD_MS&&end*1000<=now+MAX_PERIOD_MS)
            current.periodEndsAt=end*1000
          if(sub.status==='unpaid'||sub.status==='paused')current.status='suspended'
        }
      }
      if(!core.canSubscriptionTransition(previousStatus,current.status))throw bad('El evento no permite esa transición de suscripción.')
      current.revision++
      const overrides=core.ModuleOverridesSchema.parse(locked.overrides??{}),entitlements=evaluate(plan,current,overrides,now)
      const applied=(await client.query('SELECT llenamos.billing_event_commit($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS status',
        [eventHash,event.id,event.created,rid,status,observed,JSON.stringify({...current,renewalGrace}),entitlements.activeModules,JSON.stringify(entitlements.moduleOverrides),new Date(entitlements.nextEvaluationAt??now),paidInvoice])).rows[0].status as string
      return {status:applied}
    })
  }catch(error) {
    if(error instanceof ApiError)throw error
    if(error instanceof z.ZodError)throw bad('El evento de Stripe no tiene la forma esperada.')
    return billingError(error)
  }
}

/** Firma `t=<segundos>,v1=<hmac>` de Stripe con ventana de cinco minutos (misma comprobación que el receptor de V2). */
export function verifyStripeSignature(raw:Buffer,signature:string,secret:string,now=Date.now()) {
  const fields=signature.split(',').map(part=>part.trim().split('='))
  const t=fields.find(field=>field[0]==='t')?.[1]
  if(!secret||!t||!/^\d+$/.test(t)||Math.abs(now/1000-Number(t))>300)return false
  const expected=createHmac('sha256',secret).update(`${t}.`).update(raw).digest()
  return fields.some(field=>field[0]==='v1'&&/^[a-f0-9]{64}$/i.test(field[1]??'')&&timingSafeEqual(Buffer.from(field[1]!,'hex'),expected))
}
const bodyLimit=256_000
function rawBody(req:IncomingMessage):Promise<Buffer> {
  const length=req.headers['content-length']
  if(length&&(!/^\d+$/.test(length)||Number(length)>bodyLimit)){req.resume();throw new ApiError(413,'resource-exhausted','Cuerpo demasiado grande.')}
  return new Promise((resolve,reject)=>{
    const chunks:Buffer[]=[];let size=0
    req.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>bodyLimit){reject(new ApiError(413,'resource-exhausted','Cuerpo demasiado grande.'));req.destroy()}else chunks.push(chunk)})
    req.once('end',()=>resolve(Buffer.concat(chunks)))
    req.once('error',()=>reject(new ApiError(400,'invalid-argument','No se pudo leer la petición.')))
  })
}
export const BILLING_WEBHOOK_PATH='/v1/webhooks/stripe-billing'
const NOT_CONFIGURED_TEXT='La facturación de la suscripción no está configurada. No se ha realizado ningún cargo.'
function secretFromFile(file:string|undefined) {
  if(!file)return ''
  try {return readFileSync(file,'utf8').trim()}catch{return ''}
}
/**
 * Receptor del webhook de Stripe Billing de la plataforma (`POST /v1/webhooks/stripe-billing`), con el secreto de la
 * plataforma (`STRIPE_BILLING_WEBHOOK_SECRET_FILE`). Sin secreto (o con el fichero ausente) responde 503: Billing
 * queda sin configurar, no se acepta ni se simula nada y el arranque no se cae. `pool` debe ser el login
 * `llenamos_webhook` (el de los webhooks de V2), nunca el de la API: solo ese rol ejecuta las funciones `billing_event_*`.
 * No puede pasar por el receptor por restaurante de V2: allí firma cada restaurante con su propio secreto, que no
 * es de fiar para conceder o quitar servicio.
 */
export function billingWebhookRoute(options:{pool:Pool;secret?:string;provider?:BillingProvider;now?:()=>number}):PlatformRoute {
  const secret=options.secret??secretFromFile(process.env.STRIPE_BILLING_WEBHOOK_SECRET_FILE)
  return async({req,res,path})=>{
    if(path!==BILLING_WEBHOOK_PATH)return false
    const reply=(status:number,text:string)=>{res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(text)}
    if(req.method!=='POST'){req.resume();res.setHeader('Allow','POST');reply(405,'Método no permitido.');return true}
    if(!secret){req.resume();reply(503,NOT_CONFIGURED_TEXT);return true}
    try {
      const raw=await rawBody(req)
      if(!verifyStripeSignature(raw,String(req.headers['stripe-signature']??''),secret,options.now?.()))return reply(401,'Firma incorrecta.'),true
      let json:unknown
      try {json=JSON.parse(raw.toString('utf8'))}catch{return reply(400,'Evento no válido.'),true}
      await handleBillingEvent(poolRunner(options.pool),json,{provider:options.provider,now:options.now?.()})
      reply(200,'OK')
    }catch(error) {
      const retryable=error instanceof ApiError&&error.status>=500
      reply(error instanceof ApiError&&error.status===413?413:retryable?503:400,retryable?'No se ha aplicado el evento. Stripe debe reintentar.':'No se ha aplicado el evento. Revisa la facturación.')
    }
    return true
  }
}
