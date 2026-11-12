import { describe, expect, it } from 'vitest'
import { fiscalClock } from './fiscal'
import { hash, localOnly } from './context'

describe('Reloj fiscal e identidad de intenciones',() => {
  it('conserva el huso de verano e invierno y el año local al cruzar medianoche',() => {
    expect(fiscalClock(Date.parse('2026-06-20T12:00:00Z'),'Europe/Madrid')).toEqual({ year:2026,issueDate:'20-06-2026',generatedAt:'2026-06-20T14:00:00+02:00' })
    expect(fiscalClock(Date.parse('2026-12-31T23:30:00Z'),'Europe/Madrid')).toEqual({ year:2027,issueDate:'01-01-2027',generatedAt:'2027-01-01T00:30:00+01:00' })
  })
  it('aísla claves por autor, ruta y destino, incluso con identificadores parecidos',() => {
    expect(new Set([hash(['a','cobrar','b']),hash(['ab','cobrar','']),hash(['a','devolver','b']),hash(['b','cobrar','b'])]).size).toBe(4)
  })
  it('deniega el proveedor fuera del proyecto local',() => {
    const project = process.env.GCLOUD_PROJECT
    process.env.GCLOUD_PROJECT = 'produccion'
    try { expect(localOnly).toThrow('emuladores') } finally { process.env.GCLOUD_PROJECT = project }
  })
})
