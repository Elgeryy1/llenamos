import { describe,expect,it } from 'vitest'
import * as core from '@llenamos/core'
import { linea } from '../../../packages/core/src/sala/datos-prueba'
import { inventory,isLive,redactedData } from './inventory'
import { encrypt,decrypt } from './infra'
const rid='prueba',cid=core.customerIdFor(rid,'+34612345678')
describe('Adaptadores de copias personales',() => {
  it('conserva el esquema de reservas, revoca el token y no deja contacto en notas o historial',() => {
    const row = { path:`restaurants/${rid}/locations/centro/reservations/r`,data:core.ReservationSchema.parse({ guestName:'Ana',phone:'+34612345678',email:'ana@example.test',language:'es',partySize:2,startAt:12345,durationMinutes:90,status:'finished',tableIds:[],suggestedTableIds:[],suggestionReason:null,source:'phone',notes:'ana@example.test',guestNotes:'Alergia',customerId:cid,reference:'ABCD23',manageTokenHash:core.sha256Hex('TOKEN'),deposit:{ status:'none',amountCents:0,checkoutSessionId:null },history:[{ from:'confirmed',to:'finished',at:12345,by:'owner',reason:'ana@example.test' }],createdBy:'owner' }) }
    const result = redactedData(row,'a'.repeat(64))
    core.ReservationSchema.parse(result)
    expect(JSON.stringify(result)).not.toContain('ana@example.test');expect(JSON.stringify(result)).not.toContain('Alergia')
    expect(result.manageTokenHash).toBe('0'.repeat(64))
  })
  it('no une ids iguales de sesiones de locales distintos y bloquea una referencia global ambigua',() => {
    const rows = [
      { path:`restaurants/${rid}/customers/${cid}`,data:{ name:'Ana',phone:'+34612345678' } },
      { path:`restaurants/${rid}/locations/a/tableSessions/s`,data:{ customerId:cid,status:'closed' } },
      { path:`restaurants/${rid}/locations/b/tableSessions/s`,data:{ customerId:'otra',status:'closed' } },
      { path:`restaurants/${rid}/locations/b/orders/o`,data:{ sessionId:'s',notes:'OTRA_PERSONA' } },
    ]
    expect(inventory(rows,rid,cid).rows.some(r => r.data.notes === 'OTRA_PERSONA')).toBe(false)
  })
  it('incluye enlaces de sesión, revisión de devolución, costes y recomendaciones del cliente',() => {
    const base = `restaurants/${rid}`, local = `${base}/locations/centro`
    const rows = [
      { path:`${base}/customers/${cid}`,data:{ name:'Ana',phone:'+34612345678' } },
      { path:`${local}/tableSessions/s`,data:{ customerId:cid,status:'closed' } },
      { path:`${local}/reservationSessions/r`,data:{ sessionId:'s' } },
      { path:`${local}/bills/b`,data:{ customerId:cid,status:'settled',totalCents:2000 } },
      { path:`${local}/refundReviews/p`,data:{ billId:'b',reason:'Ana',amountCents:500 } },
      { path:`${local}/orders/o`,data:{ sessionId:'s' } },
      { path:`${local}/lineCosts/l`,data:{ orderId:'o',costCents:200 } },
      { path:`${base}/recommendations/a`,data:{ subject:cid,text:'Revisar visita' } },
    ]
    const inv = inventory(rows,rid,cid)
    expect(inv.ambiguous).toEqual([]);expect(inv.rows).toHaveLength(rows.length)
    expect(redactedData(rows[4]!,'a'.repeat(64))).toMatchObject({ reason:'Suprimido por privacidad',amountCents:500 })
    expect(redactedData(rows[6]!,'a'.repeat(64)).costCents).toBe(200)
    expect(redactedData(rows[7]!,'a'.repeat(64)).subject).not.toBe(cid)
  })
  it('las líneas y descuentos anonimizados siguen siendo legibles por sala, caja y análisis',() => {
    const source = linea({ notes:'Alergia de Ana',name:{ es:'Patatas bravas',ca:'Patates braves',en:'Spicy potatoes' } })
    const line = core.OrderLineSchema.parse(redactedData({ path:`restaurants/${rid}/locations/centro/orderLines/l`,data:source },'a'.repeat(64)))
    expect(line.name).toEqual(source.name);expect(line.notes).toBe('');expect(line.totalCents).toBe(source.totalCents)
    const bill = core.BillSchema.parse({ target:{ kind:'session',id:'s' },customerId:cid,status:'settled',revision:1,lines:[{ lineId:'l',parentLineId:null,name:'Patatas bravas',quantity:1,grossCents:2000,taxRate:10,guest:null }],adjustments:[{ id:'d',lineId:'l',kind:'discount',amountCents:200,reason:'Ana pidió descuento',at:12345,by:'owner',promotionId:'p' }],totalCents:1800,paidCents:1800,refundedCents:0,openedAt:12345,lockedAt:12345,settledAt:12345 })
    const result = core.BillSchema.parse(redactedData({ path:`restaurants/${rid}/locations/centro/bills/b`,data:bill },'a'.repeat(64)))
    expect(result.totalCents).toBe(1800);expect(result.lines[0]!.name).toBe('Patatas bravas')
    expect(result.adjustments[0]!.reason).toBe('Suprimido por privacidad')
    const consent:core.Consent = { customerId:cid,purpose:'marketing_email',status:'granted',policyVersion:'1',at:12345,source:'public',evidenceId:'reserva' }
    expect(core.ConsentSchema.parse(redactedData({ path:`restaurants/${rid}/consents/c`,data:consent },'a'.repeat(64))).status).toBe('withdrawn')
  })
  it('detecta mensajes reclamados aunque sigan en estado queued y expire el lease',() => {
    expect(isLive({ path:'restaurants/r/messages/m',data:{ status:'queued',claim:'intento-incierto',leaseUntil:1 } })).toBe(true)
  })
  it('el cifrado autentica el restaurante y rechaza bytes manipulados',() => {
    const old = process.env.PLATFORM_DATA_KEY_V1;process.env.PLATFORM_DATA_KEY_V1 = Buffer.alloc(32,7).toString('base64')
    try {
      const bytes = encrypt(Buffer.from('DATOS'),'restaurante-a')
      expect(decrypt(bytes,'restaurante-a').toString()).toBe('DATOS')
      expect(() => decrypt(bytes,'restaurante-b')).toThrow()
      const bad = Buffer.from(bytes);bad[30] = bad[30]! ^ 1
      expect(() => decrypt(bad,'restaurante-a')).toThrow()
    } finally { if (old === undefined) delete process.env.PLATFORM_DATA_KEY_V1;else process.env.PLATFORM_DATA_KEY_V1=old }
  })
})
