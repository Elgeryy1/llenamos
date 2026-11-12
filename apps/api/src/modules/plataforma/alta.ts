import type { PoolClient } from 'pg'
import * as core from '@llenamos/core'
import { ApiError } from '../../errors.js'
import { billingError,evaluate,hash,readPlanDefinition,subscriptionOf } from './common.js'

/** Condiciones aceptadas en el asistente; configurable cuando el texto legal definitivo exista. */
const termsVersion=()=>process.env.ONBOARDING_TERMS_VERSION||'alta-provisional-v1'
const MAX_OPEN_DRAFTS=5
/** El alta por cuenta propia es una decisión de despliegue: apagada, solo LogiQD da de alta restaurantes. */
export function assertSelfSignup() {
  if(process.env.PLATFORM_SELF_SIGNUP!=='1')throw new ApiError(403,'permission-denied','El alta de restaurantes la realiza el equipo de LogiQD.')
}
async function selfReceipt(client:PoolClient,uid:string,operation:'guardarAlta'|'completarAlta',requestId:string,input:unknown) {
  const fingerprint=hash(input)
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${uid}:${operation}:${requestId}`])
  const {rows}=await client.query<{request_hash:string;result:unknown}>('SELECT request_hash,result FROM llenamos.platform_self_requests WHERE actor_uid=$1 AND operation=$2 AND request_key=$3',[uid,operation,requestId])
  if(rows[0]&&rows[0].request_hash!==fingerprint)throw new ApiError(409,'already-exists','Este identificador ya se usó con otros datos.')
  return {result:rows[0]?.result??null,
    save:(result:unknown)=>client.query('INSERT INTO llenamos.platform_self_requests(actor_uid,operation,request_key,request_hash,result) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[uid,operation,requestId,fingerprint,JSON.stringify(result)])}
}

export async function saveOnboarding(client:PoolClient,data:unknown,context:{uid:string}) {
  assertSelfSignup()
  const input=core.GuardarAltaInputSchema.parse(data),uid=context.uid
  try {
    const previous=await selfReceipt(client,uid,'guardarAlta',input.requestId,input)
    if(previous.result!==null)return core.GuardarAltaOutputSchema.parse(previous.result)
    const id=input.onboardingId??hash([uid,input.requestId])
    const {rows}=await client.query('SELECT * FROM llenamos.platform_onboardings WHERE id=$1 AND owner_uid=$2 FOR UPDATE',[id,uid])
    const old=rows[0]
    if(input.onboardingId&&!old)throw new ApiError(404,'not-found','No se encuentra el borrador.')
    if(old&&(old.revision!==input.expectedRevision||!['draft','failed'].includes(old.status)))throw new ApiError(409,'aborted','El borrador ha cambiado. Recupera la última revisión.')
    if(!old) {
      const open=await client.query("SELECT count(*)::int AS n FROM llenamos.platform_onboardings WHERE owner_uid=$1 AND status IN ('draft','failed')",[uid])
      if(open.rows[0].n>=MAX_OPEN_DRAFTS)throw new ApiError(429,'resource-exhausted','Hay demasiados borradores abiertos. Termina o descarta alguno.')
    }
    const draft=core.OnboardingDraftSchema.partial().parse({...(old?.draft??{}),...input.draft})
    const revision=(old?.revision??0)+1
    await client.query(`INSERT INTO llenamos.platform_onboardings(id,owner_uid,status,step,revision,request_id,draft) VALUES($1,$2,'draft',$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET status='draft',step=excluded.step,revision=excluded.revision,request_id=excluded.request_id,draft=excluded.draft,error=NULL,trial_used=false,updated_at=now()`,
      [id,uid,input.step,revision,input.requestId,JSON.stringify(draft)])
    const response=core.GuardarAltaOutputSchema.parse({onboardingId:id,onboarding:{ownerUid:uid,restaurantId:null,status:'draft',step:input.step,revision,requestId:input.requestId,error:null,trialUsed:false}})
    await previous.save(response)
    return response
  }catch(error){return billingError(error)}
}

export async function completeOnboarding(client:PoolClient,data:unknown,context:{uid:string}) {
  assertSelfSignup()
  const input=core.CompletarAltaInputSchema.parse(data),uid=context.uid
  try {
    const previous=await selfReceipt(client,uid,'completarAlta',input.requestId,input)
    if(previous.result!==null)return core.CompletarAltaOutputSchema.parse(previous.result)
    const {rows}=await client.query('SELECT * FROM llenamos.platform_onboardings WHERE id=$1 AND owner_uid=$2',[input.onboardingId,uid])
    const row=rows[0]
    if(!row)throw new ApiError(404,'not-found','No se encuentra el borrador.')
    if(row.revision!==input.expectedRevision||!['draft','failed'].includes(row.status))throw new ApiError(409,'aborted','El borrador ha cambiado o ya está terminado.')
    const draft=core.OnboardingDraftSchema.parse(row.draft)
    if(draft.acceptedTermsVersion!==termsVersion())throw new ApiError(412,'failed-precondition','Revisa y acepta las condiciones de la prueba.')
    const plan=await readPlanDefinition(client,draft.planId,draft.planVersion)
    if(!plan.enabled)throw new ApiError(412,'failed-precondition','El plan ya no está disponible para nuevas altas.')
    if(!core.checkPlanLimit(plan.limits,'locations',0).ok||!core.checkPlanLimit(plan.limits,'members',0).ok)throw new ApiError(412,'failed-precondition','El plan no permite abrir un restaurante.')
    const rid=`alta_${hash([uid,input.onboardingId]).slice(0,32)}`
    const created=(await client.query('SELECT llenamos.billing_onboarding_complete($1,$2,$3,$4,$5) AS result',[input.onboardingId,input.expectedRevision,rid,core.slugify(draft.location.name)||'principal',input.requestId])).rows[0].result
    const subscription=subscriptionOf(created.subscription)
    await provisionDefaults(client,created.restaurantId,created.locationId,draft,uid)
    const response=core.CompletarAltaOutputSchema.parse({restaurantId:created.restaurantId,locationId:created.locationId,subscription,entitlements:evaluate(plan,subscription,{},Date.now())})
    // El receipt vive con la cuenta (no con el restaurante nuevo), así un reintento recupera la respuesta perdida.
    await previous.save(response)
    return response
  }catch(error){return billingError(error)}
}

/**
 * Ajustes mínimos para que el restaurante nuevo funcione: horarios de reservas, plano sencillo, estación de cocina, ajustes
 * de sala y, si se pidió, una carta interna sin publicar. Se escriben como el propio propietario, con el contexto del
 * restaurante recién creado (no hay otro camino y no se amplía ninguna política). Alérgenos sin revisar y pedido público apagado.
 */
async function provisionDefaults(client:PoolClient,rid:string,lid:string,draft:core.OnboardingDraft,uid:string) {
  await client.query("SELECT set_config('app.restaurant_id',$1,true)",[rid])
  const insert=(table:string,columns:string,values:unknown[])=>client.query(`INSERT INTO llenamos.${table}(${columns}) VALUES(${values.map((_,i)=>`$${i+1}`).join(',')})`,values.map(value=>typeof value==='object'&&value!==null?JSON.stringify(value):value))
  const settings=core.ReservationSettingsSchema.parse(draft.settings)
  await insert('reservation_settings','restaurant_id,location_id,data,updated_by',[rid,lid,settings,uid])
  await insert('sala_settings','restaurant_id,location_id,kind,doc,updated_by',[rid,lid,'floor',{...core.defaultFloorSettings(),defaultStationId:'cocina'},uid])
  await insert('sala_stations','restaurant_id,location_id,id,doc,updated_by',[rid,lid,'cocina',core.StationSchema.parse({name:'Cocina',kind:'kitchen',sortOrder:0,active:true,targetMinutes:15,pickup:true}),uid])
  const floor=draft.floor??{areaName:'Sala',tableCount:6,seats:4}
  await insert('dining_areas','restaurant_id,location_id,id,data,updated_by',[rid,lid,'sala',core.AreaSchema.parse({name:floor.areaName,sortOrder:0}),uid])
  const columns=Math.min(4,floor.tableCount),rows=Math.ceil(floor.tableCount/columns)
  for(let i=0;i<floor.tableCount;i++) {
    const table=core.TableSchema.parse({name:`Mesa ${i+1}`,areaId:'sala',seats:floor.seats,shape:i%2?'round':'rect',x:8+(i%columns)*(84/columns),y:10+Math.floor(i/columns)*(80/rows),w:Math.min(16,65/columns),h:Math.min(16,60/rows),joinableWith:[],enabled:true})
    await insert('dining_tables','restaurant_id,location_id,id,area_id,data,updated_by',[rid,lid,`mesa_${i+1}`,'sala',table,uid])
  }
  if(draft.menu?.length) {
    await insert('sala_menu_categories','restaurant_id,location_id,id,doc,updated_by',[rid,lid,'carta',core.MenuCategorySchema.parse({name:{es:'Nuestra carta'},description:{},sortOrder:0,active:true}),uid])
    for(const [i,item] of draft.menu.entries())
      await insert('sala_menu_items','restaurant_id,location_id,id,doc,updated_by',[rid,lid,`plato_${i+1}`,core.MenuItemSchema.parse({categoryId:'carta',name:{es:item.name},description:{},sortOrder:i,priceCents:item.priceCents,course:'first',stationId:'cocina',soldOut:false,version:1,allergensReviewed:false,selfOrder:false,takeaway:false,updatedBy:uid}),uid])
  }
}
