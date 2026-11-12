import { createHmac } from 'node:crypto'
import { expect,it } from 'vitest'
import { verifyStripe, verifyWhatsApp } from './signatures'
it('valida bytes originales, varios v1 y tolerancia de cinco minutos', () => {
 const raw=Buffer.from('{"a":1}'),secret='test',now=1800000000000,t=String(now/1000)
 const v1=createHmac('sha256',secret).update(`${t}.`).update(raw).digest('hex')
 expect(verifyStripe(raw,`t=${t},v1=bad,v1=${v1}`,secret,now)).toBe(true)
 expect(verifyStripe(Buffer.from('{}'),`t=${t},v1=${v1}`,secret,now)).toBe(false)
 expect(verifyStripe(raw,`t=${t},v1=${v1}`,secret,now+301000)).toBe(false)
 expect(verifyStripe(raw,`t=${t},v1=${v1}`,secret,now-301000)).toBe(false)
 expect(verifyStripe(raw,`t=${t},v1=${v1}`,secret,now+299000)).toBe(true)
 expect(verifyStripe(raw,`v1=${v1}`,secret,now)).toBe(false)
 expect(verifyStripe(raw,`t=${t},v1=${v1}`,'',now)).toBe(false)
 expect(verifyStripe(raw,'t=NaN,v1=invalid',secret,now)).toBe(false)
 const wa='sha256='+createHmac('sha256',secret).update(raw).digest('hex')
 expect(verifyWhatsApp(raw,wa,secret)).toBe(true)
 expect(verifyWhatsApp(Buffer.from('{}'),wa,secret)).toBe(false)
})
