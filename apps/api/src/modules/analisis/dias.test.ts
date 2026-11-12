import { describe, expect, it } from 'vitest'
import { buildDay, combineDishes, combineHours, combineMargin, type DayRecord } from './dias.js'
import { fakeDayFacts } from './pruebas/dobles.js'
import { dates, stableUuid } from './util.js'

const day = (lid: string, date: string, scale = 1): DayRecord => ({ ...buildDay(fakeDayFacts(lid, date, scale), lid, date, 'Europe/Madrid'), computedAt: 1 })

describe('instantáneas diarias (sin base de datos)', () => {
  it('calcula totales, tramos de 15 minutos, platos y margen de un día', () => {
    const d = day('a-main', '2026-09-01')
    expect(d.totals.grossSalesCents).toBe(10_000)
    expect(d.totals.bills).toBe(2)
    expect(d.totals.guests).toBe(4)
    expect(d.totals.noShows).toBe(1)
    expect(d.hours.slots.map(s => s.slot)).toContain('13:30')
    expect(d.dishes.rows.map(r => r.itemId)).toEqual(['paella', 'flan'])
    expect(d.dishes.rows[0]).toMatchObject({ units: 3, unitsInMenu: 1, salesCents: 6000 })
    expect(d.dishes.zero.map(z => z.itemId)).toEqual(['tarta'])
    expect(d.margin).toMatchObject({ costCents: 1500, units: 3, coveredUnits: 3 })
  })
  it('suma tramos de varios días y los agrupa en 30 o 60 minutos', () => {
    const days = [day('a-main', '2026-09-01'), day('a-main', '2026-09-02')]
    const h15 = combineHours(days, 15), h60 = combineHours(days, 60)
    expect(h15.slots.find(s => s.slot === '13:30')).toMatchObject({ guests: 8, bills: 2, salesCents: 16_000 })
    expect(h60.slots.find(s => s.slot === '13:00')).toMatchObject({ guests: 8, reservations: 2, reservationCovers: 8 })
    expect(h60.peak).toBe('13:00')
    expect(combineHours(days, 30).slots.map(s => s.slot)).toContain('13:30')
    expect(combineHours([], 60)).toEqual({ slots: [], peak: null })
  })
  it('combina platos: top por unidades y cero ventas solo si no se vendieron en el periodo', () => {
    const a = day('a-main', '2026-09-01')
    const b = day('a-main', '2026-09-02', 2)
    // La tarta se vendió el segundo día: ya no es de cero ventas aunque estuviera en la lista del primero.
    b.dishes.rows.push({ itemId: 'tarta', name: 'Tarta', units: 1, unitsInMenu: 0, salesCents: 400 })
    b.dishes.zero = [{ itemId: 'zumo', name: 'Zumo' }]
    a.dishes.zero.push({ itemId: 'zumo', name: 'Zumo' })
    const merged = combineDishes([b, a])
    expect(merged.rows[0]).toMatchObject({ itemId: 'paella', units: 9, unitsInMenu: 2, salesCents: 18_000 })
    expect(merged.zeroSales.map(z => z.itemId)).toEqual(['zumo'])
  })
  it('el margen suma las partes diarias y es null sin datos de coste', () => {
    const a = day('a-main', '2026-09-01')
    expect(combineMargin([a, a])).toMatchObject({ costCents: 3000, coveredNetCents: 10_910, marginBp: expect.any(Number), coverageBp: 10_000 })
    expect(combineMargin([{ margin: null }])).toBeNull()
  })
  it('ids estables y fechas', () => {
    expect(stableUuid('x')).toBe(stableUuid('x'))
    expect(stableUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(stableUuid('x')).not.toBe(stableUuid('y'))
    expect(dates('2026-02-27', '2026-03-01')).toEqual(['2026-02-27', '2026-02-28', '2026-03-01'])
  })
})
