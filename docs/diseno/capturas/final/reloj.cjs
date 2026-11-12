// Solo para pnpm seed:servicio. Fija el instante del servicio sin alterar los plazos
// de red de gRPC, el reloj del sistema ni las marcas de tiempo de Firestore.
const realNow = Date.now
const instante = Date.parse(process.env.LLENAMOS_CAPTURA_INSTANTE || '2026-11-09T21:12:00+01:00')
Date.now = () => {
  const caller = new Error().stack.split('\n')[2] || ''
  return caller.includes('/scripts/seed-servicio.ts:') ? instante : realNow()
}
