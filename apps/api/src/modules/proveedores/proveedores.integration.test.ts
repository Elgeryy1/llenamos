import type { AddressInfo } from 'node:net'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import { withIdentity } from '../../database.js'
import type { IdentityToken } from '../../auth.js'
import { apiServer } from '../../server.js'
import { integrationVault } from '../../platform/integrations.js'
import { createTestDatabase } from '../../test-support.js'

const enabled=process.env.TEST_POSTGRES_API==='1'&&!!process.env.TEST_POSTGRES_URL
const token=(uid:string,version:string):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false})
const SECRET='sk_live_valor_que_no_debe_salir_nunca'

describe.skipIf(!enabled)('Proveedores del restaurante en PostgreSQL',()=>{
  let db:Awaited<ReturnType<typeof createTestDatabase>>,app:Pool,server:ReturnType<typeof apiServer>,withoutVault:ReturnType<typeof apiServer>,base:string,baseNoVault:string
  const vault=integrationVault(Buffer.alloc(32,7))
  const identities:Record<string,IdentityToken>={'owner-a':token('owner-a','a'),'manager-a':token('manager-a','b'),'owner-b':token('owner-b','c'),'owner-c':token('owner-c','d')}
  const call=async(name:string,data:unknown,actor:string,url=base)=>{
    const response=await fetch(`${url}/v1/operations/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${actor}`},body:JSON.stringify({data})})
    const body=await response.json() as {result?:any;error?:{code:string}}
    return {status:response.status,body,result:body.result,code:body.error?.code}
  }
  beforeAll(async()=>{
    db=await createTestDatabase('proveedores')
    app=new Pool({connectionString:db.appUrl,max:4})
    for(const [uid,v] of [['owner-a','a'],['manager-a','b'],['owner-b','c'],['owner-c','d']] as const)await db.admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,v.repeat(32)])
    for(const rid of ['ra','rb']) {
      await db.admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$1,$1,'sala','{reservations}')",[rid])
      await db.admin.query("INSERT INTO llenamos.platform_restaurants(restaurant_id,name,slug,owner_email,plan_id,plan_version,status,active_modules) VALUES($1,$1,$1,$2,'sala',1,'trialing','{reservations}')",[rid,`${rid}@example.test`])
    }
    // `rc` no tiene ficha de plataforma: guardar no debe quedar a medias.
    await db.admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES('rc','rc','rc','sala','{reservations}')")
    for(const [rid,uid,role] of [['rc','owner-c','owner'],['ra','owner-a','owner'],['ra','manager-a','manager'],['rb','owner-b','owner']])
      await db.admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[rid,uid,role,`${uid}@example.test`])
    const verify=async(value:string)=>identities[value]??(()=>{throw new Error('sin identidad')})()
    server=apiServer(app,verify,undefined,{integrationVault:vault})
    withoutVault=apiServer(app,verify)
    for(const s of [server,withoutVault])await new Promise<void>(resolve=>s.listen(0,'127.0.0.1',resolve))
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
    baseNoVault=`http://127.0.0.1:${(withoutVault.address() as AddressInfo).port}`
  },60_000)
  afterAll(async()=>{
    for(const s of [server,withoutVault]){s?.closeAllConnections();if(s)await new Promise<void>(resolve=>s.close(()=>resolve()))}
    await db?.drop(app)
  })

  it('sin claves guardadas todo está sin configurar',async()=>{
    const r=await call('verProveedoresRestaurante',{restaurantId:'ra'},'owner-a')
    expect(r.status).toBe(200)
    expect(r.result.providers.stripe).toEqual({configured:false,status:'not_configured'})
    expect(r.result.savedFields.stripe).toEqual([])
  })

  it('el propietario guarda; solo se devuelven estados y nombres de campo, y la base solo tiene texto sellado',async()=>{
    const r=await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{stripe:{secretKey:SECRET,webhookSecret:'whsec_abcdefgh'},email:{apiKey:'re_123',from:'hola@casa.test'}}},'owner-a')
    expect(r.status,JSON.stringify(r.body)).toBe(200)
    expect(JSON.stringify(r.body)).not.toContain(SECRET)
    expect(r.result.providers.stripe).toEqual({configured:true,status:'configured'})
    expect(r.result.providers.email).toEqual({configured:true,status:'configured'})
    expect(r.result.providers.whatsapp.configured).toBe(false)
    expect(r.result.savedFields.stripe).toEqual(['secretKey','webhookSecret'])
    const sealed=(await db.admin.query("SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id='ra'")).rows[0].ciphertext as string
    expect(sealed).not.toContain(SECRET)
    expect(vault.open('ra',sealed).stripe?.secretKey).toBe(SECRET)
    // El estado derivado y el secreto de firma quedan donde los lee el resto del sistema.
    expect((await db.admin.query("SELECT integration_status->'stripe'->>'configured' AS c FROM llenamos.platform_restaurants WHERE restaurant_id='ra'")).rows[0].c).toBe('true')
    const hook=(await db.admin.query("SELECT ciphertext FROM llenamos.integration_webhook_secrets WHERE restaurant_id='ra' AND provider='stripe'")).rows[0].ciphertext as string
    expect(vault.openWebhook('ra','stripe',hook).webhookSecret).toBe('whsec_abcdefgh')
    const view=await call('verProveedoresRestaurante',{restaurantId:'ra'},'owner-a')
    expect(JSON.stringify(view.body)).not.toContain(SECRET)
    expect(view.result.providers.email.configured).toBe(true)
  })

  it('un campo vacío conserva lo guardado, un valor nuevo lo cambia y quitar borra el proveedor entero con su firma',async()=>{
    await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{stripe:{secretKey:'',webhookSecret:'whsec_nuevo123'}}},'owner-a')
    const sealed=(await db.admin.query("SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id='ra'")).rows[0].ciphertext as string
    expect(vault.open('ra',sealed).stripe).toEqual({secretKey:SECRET,webhookSecret:'whsec_nuevo123'})
    const removed=await call('guardarProveedoresRestaurante',{restaurantId:'ra',remove:['stripe']},'owner-a')
    expect(removed.result.providers.stripe.configured).toBe(false)
    expect(removed.result.providers.email.configured).toBe(true)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.integration_webhook_secrets WHERE restaurant_id='ra' AND provider='stripe'")).rows[0].n).toBe(0)
  })

  it('un encargado no puede ni ver ni guardar',async()=>{
    expect((await call('verProveedoresRestaurante',{restaurantId:'ra'},'manager-a')).status).toBe(403)
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{email:{apiKey:'x',from:'y@z.test'}}},'manager-a')).status).toBe(403)
  })

  it('aislamiento: el propietario de otro restaurante no toca ni lee los proveedores ajenos',async()=>{
    expect((await call('verProveedoresRestaurante',{restaurantId:'ra'},'owner-b')).status).toBe(403)
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{email:{apiKey:'robo',from:'y@z.test'}}},'owner-b')).status).toBe(403)
    const own=await call('verProveedoresRestaurante',{restaurantId:'rb'},'owner-b')
    expect(own.result.providers.email.configured).toBe(false)
    const sealed=(await db.admin.query("SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id='ra'")).rows[0].ciphertext as string
    expect(vault.open('ra',sealed).email?.apiKey).toBe('re_123')
  })

  it('con la identidad del propietario, la API no puede leer ni escribir la bóveda con SQL directo ni tocar la de otro',async()=>{
    const attempt=(sql:string,params:unknown[]=[],rid='ra',actor='owner-a')=>withIdentity(app,identities[actor]!,rid,client=>client.query(sql,params))
    await expect(attempt('SELECT ciphertext FROM llenamos.integration_secrets')).rejects.toThrow()
    await expect(attempt("INSERT INTO llenamos.integration_secrets(restaurant_id,ciphertext) VALUES('ra',repeat('x',50)) ON CONFLICT(restaurant_id) DO UPDATE SET ciphertext=excluded.ciphertext")).rejects.toThrow()
    await expect(attempt("UPDATE llenamos.integration_secrets SET ciphertext=repeat('y',50)")).rejects.toThrow()
    await expect(attempt("DELETE FROM llenamos.integration_secrets")).rejects.toThrow()
    await expect(attempt("INSERT INTO llenamos.integration_webhook_secrets(restaurant_id,provider,ciphertext) VALUES('ra','stripe',repeat('x',50))")).rejects.toThrow()
    // El propietario de `ra` no puede abrir ni escribir la bóveda de `rb`, aunque fije a mano la variable de la política.
    await expect(withIdentity(app,identities['owner-a']!,'ra',async client=>{await client.query("SELECT set_config('app.owner_vault','rb',true)");return client.query("SELECT llenamos.restaurant_vault_open('rb',false)")})).rejects.toMatchObject({code:'42501'})
    await expect(attempt("SELECT llenamos.restaurant_vault_save('rb',repeat('x',50),'{}'::jsonb,'{}'::jsonb)")).rejects.toMatchObject({code:'42501'})
    // El encargado tampoco, y nada de lo anterior cambió la bóveda de `ra`.
    await expect(attempt("SELECT llenamos.restaurant_vault_open('ra',true)",[],'ra','manager-a')).rejects.toMatchObject({code:'42501'})
    const sealed=(await db.admin.query("SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id='ra'")).rows[0].ciphertext as string
    expect(vault.open('ra',sealed).email?.apiKey).toBe('re_123')
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.integration_secrets WHERE restaurant_id='rb'")).rows[0].n).toBe(0)
  })

  it('dos guardados a la vez de proveedores distintos se suman: ninguno pisa al otro',async()=>{
    const results=await Promise.all([
      call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{whatsapp:{token:'t',phoneNumberId:'1',appSecret:'s',verifyToken:'v'}}},'owner-a'),
      call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{repite:{apiKey:'rk',merchantId:'m'}}},'owner-a'),
      call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{fiscal:{provider:'verifactu',apiKey:'f'}}},'owner-a'),
    ])
    for(const r of results)expect(r.status,JSON.stringify(r.body)).toBe(200)
    const sealed=(await db.admin.query("SELECT ciphertext FROM llenamos.integration_secrets WHERE restaurant_id='ra'")).rows[0].ciphertext as string
    const open=vault.open('ra',sealed)
    expect(Object.keys(open).sort()).toEqual(['email','fiscal','repite','whatsapp'])
    const status=(await db.admin.query("SELECT integration_status AS s FROM llenamos.platform_restaurants WHERE restaurant_id='ra'")).rows[0].s
    expect(['email','fiscal','repite','whatsapp'].every(p=>status[p].configured)).toBe(true)
    // El secreto de firma de WhatsApp también se guardó.
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.integration_webhook_secrets WHERE restaurant_id='ra' AND provider='whatsapp'")).rows[0].n).toBe(1)
  })

  it('valida el formato de lo que se escribe',async()=>{
    for(const integrations of [{stripe:{secretKey:'no-es-una-clave'}},{stripe:{webhookSecret:'abc'}},{stripe:{accountId:'x'}},{email:{apiKey:'k',from:'no es un correo'}}]) {
      const r=await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations},'owner-a')
      expect(r.status,JSON.stringify(integrations)).toBe(400)
    }
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{email:{from:'Casa Lola <reservas@casalola.es>'}}},'owner-a')).status).toBe(200)
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{email:{from:'reservas@casalola.es'}}},'owner-a')).status).toBe(200)
  })

  it('los campos opcionales se vacían por separado; los obligatorios no',async()=>{
    await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{stripe:{secretKey:'sk_test_12345678',webhookSecret:'whsec_12345678',accountId:'acct_123456'}}},'owner-a')
    const cleared=await call('guardarProveedoresRestaurante',{restaurantId:'ra',clear:[{provider:'stripe',field:'accountId'}]},'owner-a')
    expect(cleared.status).toBe(200)
    expect(cleared.result.savedFields.stripe).toEqual(['secretKey','webhookSecret'])
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',clear:[{provider:'stripe',field:'secretKey'}]},'owner-a')).status).toBe(400)
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',remove:['stripe']},'owner-a')).status).toBe(200)
  })

  it('sin ficha de plataforma el guardado falla entero y no deja nada a medias',async()=>{
    const r=await call('guardarProveedoresRestaurante',{restaurantId:'rc',integrations:{email:{apiKey:'k',from:'a@b.test'}}},'owner-c')
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.integration_secrets WHERE restaurant_id='rc'")).rows[0].n).toBe(0)
  })

  it('la señal pública solo se activa cuando el restaurante guarda su Stripe (el conector existe desde W3) y se apaga al retirarla',async()=>{
    const resolve=async()=>(await db.admin.query("SELECT llenamos.reservas_public_resolve(NULL,'rb',NULL) AS r")).rows[0].r.stripe as boolean
    expect(await resolve()).toBe(false)
    await call('guardarProveedoresRestaurante',{restaurantId:'rb',integrations:{stripe:{secretKey:'sk_test_12345678',webhookSecret:'whsec_12345678'}}},'owner-b')
    expect(await resolve()).toBe(true)
    await db.admin.query(`UPDATE llenamos.platform_restaurants SET integration_status=jsonb_set(integration_status,'{stripe,status}','"not_configured"') WHERE restaurant_id='rb'`)
    expect(await resolve()).toBe(false)
  })

  it('sin custodia configurada falla con su código y no guarda nada',async()=>{
    const r=await call('guardarProveedoresRestaurante',{restaurantId:'rc',integrations:{email:{apiKey:'x',from:'y@z.test'}}},'owner-c',baseNoVault)
    expect(r.status).toBe(503)
    expect((await db.admin.query("SELECT count(*)::int AS n FROM llenamos.integration_secrets WHERE restaurant_id='rc'")).rows[0].n).toBe(0)
  })

  it('rechaza campos desconocidos',async()=>{
    expect((await call('guardarProveedoresRestaurante',{restaurantId:'ra',integrations:{stripe:{otra:'x'}}},'owner-a')).status).toBe(400)
  })
})
