import { entorno } from './fase5-entorno'
async function main() {
entorno()
const p = await import('../functions/src/fase5/procesos')
const { processRepite } = await import('../functions/src/fase5/repite/service')
const { processCampaigns,captureMarketingMessages } = await import('../functions/src/fase5/marketing')
const { db } = await import('../functions/src/shared')
const core = await import('../packages/core/src/index')
const worker = process.argv[2] ?? 'todos', rid = process.argv[3] ?? 'demo-lumbre'
const jobs:Record<string,(rid:string,now:number)=>Promise<unknown>> = {
  puntos:p.expirePoints,repite:processRepite,campanas:processCampaigns,resumen:p.sendDailySummary,recomendaciones:p.evaluateAutomations,caducidad:p.expireRecommendations,eventos:p.dailyEvents,
  analisis:async (id,now) => { const root = db.doc(`restaurants/${id}`), r = await root.get(), date = core.horaLocal(now,String(r.get('timezone') ?? 'Europe/Madrid')).fecha; for (const l of (await root.collection('locations').get()).docs) for (let n=1;n<=4;n++) await p.aggregateDay(id,l.id,core.sumarDias(date,-n),now) },
  capturar:captureMarketingMessages,
}
if (worker !== 'todos' && !jobs[worker]) throw new Error('Trabajador desconocido.')
for (const [name,work] of Object.entries(jobs)) if (worker === 'todos' || worker === name) { await p.runWorker(name,work,rid); console.log(`${name}: terminado`) }
await db.terminate()

}
main().catch(error => { console.error(error); process.exitCode = 1 })
