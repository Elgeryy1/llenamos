import { mkdtempSync,writeFileSync,unlinkSync,rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { createFirebaseInvitationAuth } from './auth-admin.js'

afterEach(()=>vi.unstubAllEnvs())
describe('Credencial de identidad sin exposición de contenido',()=>{
 it.each(['{"private_key":"PRIVADO-FIXTURE-SIN-CERRAR',JSON.stringify({project_id:'llenamos-test-auth',client_email:'fixture@example.test',private_key:'PRIVADO-FIXTURE-NO-ES-PEM'})])('rechaza una credencial malformada sin imprimirla',source=>{
  vi.stubEnv('FIREBASE_AUTH_EMULATOR_HOST','')
  const folder=mkdtempSync(join(tmpdir(),'llenamos-invitation-credential-')),file=join(folder,'credential.json')
  try {
   writeFileSync(file,source)
   let caught:unknown
   try {createFirebaseInvitationAuth({projectId:'llenamos-test-auth',credentialFile:file})}catch(error){caught=error}
   expect(caught).toBeInstanceOf(Error)
   expect((caught as Error).message).toBe('No se pudo cargar la credencial de administración de identidad.')
   expect(String(caught)).not.toContain('PRIVADO-FIXTURE')
   expect((caught as Error).cause).toBeUndefined()
  } finally {unlinkSync(file);rmdirSync(folder)}
 })
})
