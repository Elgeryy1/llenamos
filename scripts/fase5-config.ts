/** Copia la configuración del worktree con los puertos exclusivos de la fila 2. */
import { readFileSync,writeFileSync } from 'node:fs'
const config:Record<string,unknown> = JSON.parse(readFileSync('firebase.json','utf8'))
const emulators:Record<string,unknown> = {singleProjectMode:true}
for(const [name,port] of Object.entries({auth:9103,firestore:8097,functions:5013,storage:9213,ui:4012,hub:4412,logging:4512,eventarc:9312,tasks:9512})) emulators[name]={host:'127.0.0.1',port,...(name==='ui'?{enabled:false}:{}),...(name==='firestore'?{websocketPort:4012}:{})}
config.emulators=emulators
writeFileSync('firebase.agente2.json',JSON.stringify(config,null,2)+'\n')
console.log('Configuración local de la fila 2 escrita en firebase.agente2.json, ignorada por git.')
