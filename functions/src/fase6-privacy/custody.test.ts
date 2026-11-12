import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Transaction } from 'firebase-admin/firestore'
import type { CallableRequest } from 'firebase-functions/v2/https'
import { assertBackupCaptureAllowed, authorize, custodyConfiguration, decrypt, encrypt, key } from './infra'

const secret = Buffer.alloc(32, 91).toString('base64')
describe('Custodia explícita de privacidad y continuidad', () => {
  beforeEach(() => {
    for (const name of ['GCLOUD_PROJECT','FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST',
      'FIREBASE_AUTH_EMULATOR_HOST','FUNCTIONS_EMULATOR','PLATFORM_CUSTODY_ENABLED','PLATFORM_DATA_BUCKET','PLATFORM_DATA_KEY_V1']) vi.stubEnv(name, '')
  })
  afterEach(() => vi.unstubAllEnvs())
  function production() {
    vi.stubEnv('GCLOUD_PROJECT','llenamos-custodia')
    vi.stubEnv('PLATFORM_CUSTODY_ENABLED','1')
    vi.stubEnv('PLATFORM_DATA_BUCKET','llenamos-custodia.firebasestorage.app')
    vi.stubEnv('PLATFORM_DATA_KEY_V1', secret)
  }
  it('no usa un bucket de demostración por defecto fuera del emulador', () => {
    expect(custodyConfiguration).toThrow('custodia de producción')
  })
  it('conserva las pruebas locales solo con ambos emuladores locales', () => {
    vi.stubEnv('GCLOUD_PROJECT','demo-llenamos')
    vi.stubEnv('FIRESTORE_EMULATOR_HOST','127.0.0.1:8085')
    vi.stubEnv('FIREBASE_STORAGE_EMULATOR_HOST','localhost:9199')
    expect(custodyConfiguration()).toEqual({local:true,bucketName:'demo-llenamos.appspot.com'})
    expect(assertBackupCaptureAllowed).not.toThrow()
    vi.stubEnv('FIREBASE_STORAGE_EMULATOR_HOST','storage.example:9199')
    expect(custodyConfiguration).toThrow()
  })
  it('exige habilitación explícita, bucket del proyecto y clave de 32 bytes', () => {
    production()
    expect(custodyConfiguration()).toEqual({local:false,bucketName:'llenamos-custodia.firebasestorage.app'})
    vi.stubEnv('PLATFORM_CUSTODY_ENABLED','')
    expect(custodyConfiguration).toThrow()
    vi.stubEnv('PLATFORM_CUSTODY_ENABLED','1')
    vi.stubEnv('PLATFORM_DATA_BUCKET','otro-proyecto.appspot.com')
    expect(custodyConfiguration).toThrow()
    vi.stubEnv('PLATFORM_DATA_BUCKET','llenamos-custodia.appspot.com')
    vi.stubEnv('PLATFORM_DATA_KEY_V1',Buffer.alloc(31).toString('base64'))
    expect(custodyConfiguration).toThrow('clave de custodia')
  })
  it('rechaza mezclar credenciales productivas y emuladores', () => {
    production()
    for (const name of ['FIRESTORE_EMULATOR_HOST','FIREBASE_STORAGE_EMULATOR_HOST','FIREBASE_AUTH_EMULATOR_HOST']) {
      vi.stubEnv(name,'localhost:9000')
      expect(custodyConfiguration).toThrow()
      vi.stubEnv(name,'')
    }
    vi.stubEnv('FUNCTIONS_EMULATOR','true')
    expect(custodyConfiguration).toThrow()
  })
  it('no declara una copia productiva coherente sin barrera de escritores', () => {
    production()
    expect(assertBackupCaptureAllowed).toThrow('barrera de mantenimiento')
  })
  it('rechaza clave base64 no canónica y detecta datos alterados o de otro ámbito', () => {
    production()
    vi.stubEnv('PLATFORM_DATA_KEY_V1',`${secret}\n`)
    expect(key).toThrow('clave de custodia')
    vi.stubEnv('PLATFORM_DATA_KEY_V1',secret)
    const bytes = encrypt(Buffer.from('privado'),'restaurants/a')
    expect(decrypt(bytes,'restaurants/a').toString()).toBe('privado')
    expect(() => decrypt(bytes,'restaurants/b')).toThrow()
    bytes[bytes.length-1] = bytes[bytes.length-1]! ^ 1
    expect(() => decrypt(bytes,'restaurants/a')).toThrow()
  })
  it('autoriza continuidad al propietario de todos los locales, nunca al equipo LogiQD', async () => {
    const member = {uid:'owner',displayName:'Propietario',email:'owner@example.test',role:'owner',active:true,locationIds:[] as string[]}
    const tx = {get:vi.fn(async () => ({data:() => member}))} as unknown as Transaction
    const request = (logiqd=false) => ({auth:{uid:'owner',token:{logiqd}}}) as unknown as CallableRequest<unknown>
    await expect(authorize(tx,'restaurante',request(),true)).resolves.toBe('owner')
    await expect(authorize(tx,'restaurante',request(true),true)).rejects.toMatchObject({code:'permission-denied'})
    member.role='manager'
    await expect(authorize(tx,'restaurante',request(),true)).rejects.toMatchObject({code:'permission-denied'})
    member.role='owner';member.locationIds=['solo-uno']
    await expect(authorize(tx,'restaurante',request(),true)).rejects.toMatchObject({code:'permission-denied'})
  })
})
