import { randomBytes } from 'node:crypto'
import { describe,expect,it } from 'vitest'
import { digest,encryptToken,decryptToken } from './crypto.js'
import { AcceptInvitationInput,InviteMemberInput } from './service.js'
describe('Invitaciones: custodia y contratos',()=>{
 it('cifra aleatoriamente y vincula la credencial a su invitación',()=>{
  const key=randomBytes(32),token=randomBytes(32).toString('base64url'),id=digest('restaurant:recipient')
  const first=encryptToken(key,id,token),second=encryptToken(key,id,token)
  expect(first).not.toEqual(second);expect(JSON.stringify(first)).not.toContain(token)
  expect(decryptToken(key,id,first)).toBe(token)
  expect(()=>decryptToken(key,digest('another:recipient'),first)).toThrow()
  expect(()=>decryptToken(randomBytes(32),id,first)).toThrow()
 })
 it('rechaza contraseñas elegidas por el invitador y exige credencial privada de aceptación',()=>{
  const invitation={restaurantId:'restaurant',email:'person@example.test',displayName:'Persona',role:'waiter'}
  expect(InviteMemberInput.safeParse(invitation).success).toBe(true)
  expect(InviteMemberInput.safeParse({...invitation,password:'Conocida-Por-Invitador'}).success).toBe(false)
  expect(AcceptInvitationInput.safeParse({invitationId:digest('id'),token:'x'.repeat(43),password:'Nueva-Privada-2026'}).success).toBe(true)
  expect(AcceptInvitationInput.safeParse({invitationId:digest('id'),token:'x'.repeat(42),password:'Nueva-Privada-2026'}).success).toBe(false)
 })
})
