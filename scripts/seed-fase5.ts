import { entorno } from './fase5-entorno'
async function main() {
  entorno()
  const { seedFase5 } = await import('../functions/src/fase5/seed')
  console.log(await seedFase5())
  const { db } = await import('../functions/src/shared'); await db.terminate()
}
main().catch(error=>{console.error(error);process.exitCode=1})
