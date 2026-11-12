import { TableSchema } from '@llenamos/core'
import { Plano } from '@/components/sala/Plano'

/** El mismo dibujo de mesas y sillas del servicio, con posiciones del aprovisionamiento. */
export function FloorPreview({ count, seats, areaName }: { count: number; seats: number; areaName: string }) {
  const safeCount = Number.isInteger(count) && count >= 1 && count <= 24 ? count : 1
  const columns = Math.min(4, safeCount), rows = Math.ceil(safeCount / columns)
  const tables = Array.from({ length: safeCount }, (_, i) => ({ id: `mesa_${i+1}`, ...TableSchema.parse({ name: `Mesa ${i+1}`, areaId: 'sala', seats: Number.isInteger(seats) && seats >= 1 && seats <= 12 ? seats : 4, shape: i%2 ? 'round':'rect', x: 8 + (i%columns)*(84/columns), y: 10+Math.floor(i/columns)*(80/rows), w: Math.min(16,65/columns), h: Math.min(16,60/rows), enabled: true, joinableWith: [] }) }))
  return <Plano tables={tables} names={new Map(tables.map(t => [t.id,t.name]))} label={`Plano de ${areaName}`} compact />
}
