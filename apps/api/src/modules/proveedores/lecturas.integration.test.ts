import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import { Pool } from 'pg'
import type { IdentityToken } from '../../auth.js'
import { withIdentity } from '../../database.js'
import type { AddressInfo } from 'node:net'
import { apiServer } from '../../server.js'
import { createTestDatabase,openStream } from '../../test-support.js'
import { proveedoresLiveQueries } from './lecturas.js'

const enabled=process.env.TEST_POSTGRES_API==='1'&&!!process.env.TEST_POSTGRES_URL
const token=(uid:string,version:string):IdentityToken=>({uid,sessionVersion:version.repeat(32),authTime:100,platformClaim:false})
const query=(name:string)=>proveedoresLiveQueries.find(q=>q.name===name)!

describe.skipIf(!enabled)('Lecturas de mensajes y equipo en PostgreSQL',()=>{
  let db:Awaited<ReturnType<typeof createTestDatabase>>,app:Pool,server:ReturnType<typeof apiServer>,base:string
  const ids:Record<string,IdentityToken>={'owner-a':token('owner-a','a'),'waiter-a':token('waiter-a','b'),'owner-b':token('owner-b','c'),'outsider':token('outsider','d')}
  const read=(actor:string,rid:string,name:string,input:unknown)=>withIdentity(app,ids[actor]!,rid,client=>query(name).snapshot(client,input,{uid:actor})) as Promise<any>
  const hiddenId=randomUUID(),emptyId=randomUUID(),futureId=randomUUID(),sentId=randomUUID(),queuedId=randomUUID(),otherId=randomUUID(),foreignId=randomUUID()
  const request=(reservationId:string,data:Record<string,unknown>={})=>({channel:'email',to:'ana@example.test',template:'confirmation',language:'es',reservationId,waitlistId:null,sendAt:Date.now(),data})

  beforeAll(async()=>{
    db=await createTestDatabase('lecturas')
    app=new Pool({connectionString:db.appUrl,max:4})
    for(const [uid,v] of [['owner-a','a'],['waiter-a','b'],['owner-b','c'],['outsider','d']] as const)await db.admin.query('INSERT INTO llenamos.identities(uid,session_version,tokens_valid_after,locked) VALUES($1,$2,to_timestamp(100),false)',[uid,v.repeat(32)])
    for(const r of ['ra','rb'])await db.admin.query("INSERT INTO llenamos.restaurants(id,name,slug,plan,active_modules) VALUES($1,$1,$1,'sala','{reservations}')",[r])
    for(const [r,uid,role] of [['ra','owner-a','owner'],['ra','waiter-a','waiter'],['rb','owner-b','owner']])
      await db.admin.query('INSERT INTO llenamos.memberships(restaurant_id,uid,role,active,display_name,email) VALUES($1,$2::text,$3,true,$2::text,$4)',[r,uid,role,`${uid}@example.test`])
    await db.admin.query("INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,provider,context,rendered_subject) VALUES($1,'ra','email','confirmation','ana@example.test','sent','resend','{\"reservationId\":\"res1\"}','Reserva confirmada')",[sentId])
    await db.admin.query("INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,context) VALUES($1,'ra','email','reminder','otra@example.test','failed','{\"reservationId\":\"res2\"}')",[otherId])
    await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload) VALUES($1,'ra','mensaje.enviar',$2)",[queuedId,JSON.stringify(request('res1',{manageUrl:'https://app.test/gestion?token=SECRETO',guestName:'Ana'}))])
    // Privacidad: el destinatario suprimido o vacío no es un correo ni un teléfono y no debe tumbar la bandeja.
    await db.admin.query("INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,context) VALUES($1,'ra','email','confirmation','suprimido','sent','{\"reservationId\":\"res1\"}'),($2,'ra','whatsapp','takeaway_ready','','cancelled','{\"reservationId\":\"res1\"}')",[hiddenId,emptyId])
    // Un recordatorio programado para dentro de una semana no es «reciente».
    await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,occurred_at) VALUES($1,'ra','mensaje.enviar',$2,now()-interval '5 days')",[futureId,JSON.stringify({...request('res9'),sendAt:Date.now()+7*86_400_000})])
    await db.admin.query("INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,context) VALUES($1,'rb','email','confirmation','b@example.test','sent','{\"reservationId\":\"res1\"}')",[foreignId])
    server=apiServer(app,async value=>ids[value]??(()=>{throw new Error('sin identidad')})())
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
    base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`
  },60_000)
  afterAll(async()=>{server?.closeAllConnections();if(server)await new Promise<void>(resolve=>server.close(()=>resolve()));await db?.drop(app)})
  /** Por el servicio en vivo, como el navegador: aquí sí se comprueban rol y pertenencia al restaurante. */
  const stream=async(actor:string,name:string,input:unknown)=>{
    const s=await openStream(base,name,actor,input)
    try {
      if(s.response.status!==200)return {status:s.response.status,snapshot:null as any}
      await s.until(()=>s.snapshots().length>0)
      return {status:200,snapshot:JSON.parse(s.snapshots()[0]!.data!) as any}
    } finally { await s.close() }
  }

  it('la bandeja junta resultados y avisos en cola, sin enlaces con token',async()=>{
    const out=await read('owner-a','ra','mensajesRecientes',{restaurantId:'ra',limit:50})
    const byId=Object.fromEntries(out.messages.map((m:any)=>[m.id,m]))
    expect(Object.keys(byId).sort()).toEqual([sentId,queuedId,otherId,hiddenId,emptyId,futureId].sort())
    expect(byId[sentId]).toMatchObject({status:'sent',provider:'resend',reservationId:'res1'})
    expect(byId[queuedId]).toMatchObject({status:'queued',data:{guestName:'Ana'}})
    expect(byId[hiddenId]).toMatchObject({to:'suprimido',status:'sent'})
    expect(byId[emptyId]).toMatchObject({to:'',status:'cancelled'})
    expect(JSON.stringify(out)).not.toContain('SECRETO')
    expect(JSON.stringify(out)).not.toContain('b@example.test')
  })

  it('por reserva solo salen los avisos de esa reserva',async()=>{
    const out=await read('owner-a','ra','mensajesReserva',{restaurantId:'ra',reservationId:'res1'})
    expect(out.messages.map((m:any)=>m.id).sort()).toEqual([sentId,queuedId,hiddenId,emptyId].sort())
  })

  it('respeta el límite pedido',async()=>{
    expect((await read('owner-a','ra','mensajesRecientes',{restaurantId:'ra',limit:1})).messages).toHaveLength(1)
  })

  it('el camarero no tiene permiso de bandeja, pero ve al equipo',async()=>{
    expect(query('mensajesRecientes').roles).not.toContain('waiter')
    const team=await read('waiter-a','ra','miembros',{restaurantId:'ra'})
    expect(team.map((m:any)=>m.uid).sort()).toEqual(['owner-a','waiter-a'])
    expect(team[0]).toMatchObject({active:true,locationIds:[]})
  })

  it('aislamiento: otro restaurante ni ve el equipo ni los avisos',async()=>{
    await expect(read('owner-b','ra','miembros',{restaurantId:'ra'})).rejects.toThrow()
    await expect(read('outsider','ra','miembros',{restaurantId:'ra'})).rejects.toThrow()
    const own=await read('owner-b','rb','mensajesRecientes',{restaurantId:'rb',limit:50})
    expect(own.messages.map((m:any)=>m.id)).toEqual([foreignId])
    expect((await read('owner-b','rb','miembros',{restaurantId:'rb'})).map((m:any)=>m.uid)).toEqual(['owner-b'])
  })

  it('una fila con destinatario suprimido o vacío no tumba la lectura por el servicio en vivo',async()=>{
    const all=await stream('owner-a','mensajesRecientes',{restaurantId:'ra',limit:50})
    expect(all.status).toBe(200)
    expect(all.snapshot.messages.map((m:any)=>m.id)).toEqual(expect.arrayContaining([hiddenId,emptyId]))
    const one=await stream('owner-a','mensajesReserva',{restaurantId:'ra',reservationId:'res1'})
    expect(one.status).toBe(200)
    expect(one.snapshot.messages.map((m:any)=>m.id)).toEqual(expect.arrayContaining([hiddenId,emptyId]))
  })

  it('los avisos enviados conservan el nombre del cliente de la cola y no sus enlaces',async()=>{
    const id=randomUUID()
    await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,status) VALUES($1,'ra','mensaje.enviar',$2,'done')",[id,JSON.stringify(request('res3',{guestName:'Marta',manageUrl:'https://x.test/?token=OTRO'}))])
    await db.admin.query("INSERT INTO llenamos.message_deliveries(id,restaurant_id,channel,template,recipient,status,context) VALUES($1,'ra','email','confirmation','marta@example.test','sent','{\"reservationId\":\"res3\"}')",[id])
    const out=await read('owner-a','ra','mensajesReserva',{restaurantId:'ra',reservationId:'res3'})
    expect(out.messages).toHaveLength(1)
    expect(out.messages[0].data).toEqual({guestName:'Marta'})
    expect(JSON.stringify(out)).not.toContain('OTRO')
  })

  it('la bandeja ordena por creación: un recordatorio futuro no desplaza a lo reciente',async()=>{
    const out=await read('owner-a','ra','mensajesRecientes',{restaurantId:'ra',limit:3})
    expect(out.messages.map((m:any)=>m.id)).not.toContain(futureId)
    const all=await read('owner-a','ra','mensajesRecientes',{restaurantId:'ra',limit:50})
    expect(all.messages.at(-1).id).toBe(futureId)
  })

  it('por el servicio en vivo: el camarero y el propietario de otro restaurante reciben 403',async()=>{
    expect((await stream('waiter-a','mensajesRecientes',{restaurantId:'ra',limit:10})).status).toBe(403)
    expect((await stream('waiter-a','mensajesReserva',{restaurantId:'ra',reservationId:'res1'})).status).toBe(403)
    expect((await stream('owner-b','mensajesRecientes',{restaurantId:'ra',limit:10})).status).toBe(403)
    expect((await stream('owner-b','mensajesReserva',{restaurantId:'ra',reservationId:'res1'})).status).toBe(403)
    expect((await stream('owner-b','miembros',{restaurantId:'ra'})).status).toBe(403)
    expect((await stream('waiter-a','miembros',{restaurantId:'ra'})).status).toBe(200)
  })

  it('las consultas de la cola usan sus índices (no recorren toda la tabla)',async()=>{
    // Muchos terminados de otros restaurantes y solo unos pocos pendientes del nuestro.
    await db.admin.query("INSERT INTO llenamos.outbox(id,restaurant_id,kind,payload,status) SELECT gen_random_uuid(),'rb','mensaje.enviar',jsonb_build_object('reservationId','r'||g),'done' FROM generate_series(1,4000) g")
    await db.admin.query('ANALYZE llenamos.outbox')
    const explain=async(sql:string,params:unknown[])=>{
      const client=await db.admin.connect()
      try { await client.query('BEGIN');await client.query('SET LOCAL enable_seqscan=off');return (await client.query(`EXPLAIN ${sql}`,params)).rows.map(r=>r['QUERY PLAN']).join('\n') }
      finally { await client.query('ROLLBACK');client.release() }
    }
    const recent=await explain("SELECT o.id FROM llenamos.outbox o WHERE o.restaurant_id=$1 AND o.kind='mensaje.enviar' AND o.status IN ('pending','leased','failed','quarantined') ORDER BY o.occurred_at DESC,o.id LIMIT 50",['ra'])
    expect(recent).toContain('outbox_notices_recent')
    expect(recent).not.toContain('Seq Scan')
    const byReservation=await explain("SELECT o.id FROM llenamos.outbox o WHERE o.restaurant_id=$1 AND o.kind='mensaje.enviar' AND o.status IN ('pending','leased','failed','quarantined') AND o.payload->>'reservationId'=$2 ORDER BY o.occurred_at DESC,o.id LIMIT 50",['ra','res1'])
    // Cualquiera de los dos índices parciales del restaurante sirve; lo que no vale es recorrer la tabla.
    expect(byReservation).toMatch(/outbox_notices_(recent|reservation)/)
    expect(byReservation).not.toContain('Seq Scan')
  })
})
