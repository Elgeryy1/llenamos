import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MODULES } from './index.js'

// La web pide estas lecturas por nombre: si la API deja de registrarlas, la pantalla se queda en «no desplegado».
const WEB = join(__dirname, '../../../web/src/lib')
const FICHEROS = ['analisis/datos.ts', 'campanas/datos.ts', 'fidelizacion/datos.ts']

describe('lecturas en vivo que pide la web de gestión', () => {
  const registradas = new Set(MODULES.flatMap(m => m.liveQueries ?? []).map(q => q.name))
  for (const fichero of FICHEROS) {
    it(`${fichero}: todas las lecturas por nombre existen en la API`, () => {
      const fuente = readFileSync(join(WEB, fichero), 'utf8')
      const nombres = [...fuente.matchAll(/["']((?:analisis|campanas|fidelizacion)\.[a-zA-Z]+)["']/g)].map(m => m[1]!).filter(n => n !== 'fidelizacion.desconocida')
      expect(nombres.length).toBeGreaterThan(0)
      for (const nombre of nombres) expect(registradas, nombre).toContain(nombre)
    })
  }
})
