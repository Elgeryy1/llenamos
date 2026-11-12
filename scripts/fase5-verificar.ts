import { existsSync,readFileSync,writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { entorno } from './fase5-entorno'
entorno()
const path='/tmp/f5-backend-key-v1'
if(!existsSync(path)) writeFileSync(path,randomBytes(32).toString('base64'),{mode:0o600})
const [command,...args]=process.argv.slice(2)
if(!command) throw new Error('Indica el comando que quieres verificar en local.')
const child=spawn(command,args,{stdio:'inherit',env:{...process.env,PLATFORM_DATA_KEY_V1:readFileSync(path,'utf8').trim(),XDG_CONFIG_HOME:'/tmp/f5-backend-config',XDG_DATA_HOME:'/tmp/f5-backend-data',XDG_CACHE_HOME:'/tmp/f5-backend-cache'}})
for(const signal of ['SIGINT','SIGTERM'] as const) process.on(signal,()=>child.kill(signal))
child.on('error',error=>{console.error(error);process.exitCode=1})
child.on('exit',code=>{process.exitCode=code??1})
