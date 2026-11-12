import { entorno } from './fase5-entorno'
async function main() {
entorno()
const { build } = await import('../functions/node_modules/tsup/dist/index.js')
await build({ entry:{ index:'functions/src/index.ts' },outDir:'functions/lib',format:['esm'],target:'node22',platform:'node',sourcemap:true,clean:true,noExternal:['@llenamos/core','zod'],external:['firebase-admin','firebase-functions'],outExtension:() => ({ js:'.js' }),config:false })

}
main().catch(error => { console.error(error); process.exitCode = 1 })
