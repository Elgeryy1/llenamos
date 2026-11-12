import { createCipheriv,createDecipheriv,createHash,randomBytes } from 'node:crypto'
export const digest=(value:string)=>createHash('sha256').update(value).digest('hex')
export type TokenEnvelope={iv:string;tag:string;data:string}
export function encryptToken(key:Buffer,id:string,token:string):TokenEnvelope {
  if(key.length!==32)throw new Error('La clave de invitaciones debe tener 32 bytes.')
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv)
  cipher.setAAD(Buffer.from(`llenamos:account-invitation:v1:${id}`))
  const data=Buffer.concat([cipher.update(token,'utf8'),cipher.final()])
  return {iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),data:data.toString('base64url')}
}
export function decryptToken(key:Buffer,id:string,value:TokenEnvelope) {
  const cipher=createDecipheriv('aes-256-gcm',key,Buffer.from(value.iv,'base64url'))
  cipher.setAAD(Buffer.from(`llenamos:account-invitation:v1:${id}`));cipher.setAuthTag(Buffer.from(value.tag,'base64url'))
  return Buffer.concat([cipher.update(Buffer.from(value.data,'base64url')),cipher.final()]).toString('utf8')
}
