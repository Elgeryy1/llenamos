/**
 * Datos de demostración de la fase 4 para Taberna Lumbre (inventados). Solo emuladores.
 *
 * Todo pasa por las callables de verdad, con `requestId` fijos: repetir el seed devuelve el
 * resultado original y no duplica nada. Los fichajes y el cuadrante se calculan por fecha
 * (los últimos seis días y la semana en curso y la siguiente), así que al día siguiente se
 * añaden los días nuevos sin tocar los anteriores. Los PIN de demostración son 1234 (Diego),
 * 2345 (Lucía), 3456 (Pau) y 4567 (Nora).
 */
import { type CallableRequest } from 'firebase-functions/v2/https'
import { getAuth } from 'firebase-admin/auth'
import { Timestamp } from 'firebase-admin/firestore'
import * as core from '@llenamos/core'
import { db } from '../shared'
import { execute } from './index'
import type { Name } from './context'

function localOnly() {
  if (process.env.GCLOUD_PROJECT !== 'demo-llenamos' || !process.env.FIRESTORE_EMULATOR_HOST) throw new Error('El seed de la fase 4 solo funciona en los emuladores de demo.')
}

const MIN = 60_000
export interface SeedTarget {
  restaurantId: string
  locationId: string
  /** uid de cada cuenta de demostración; por defecto se buscan por correo (`propietario@lumbre.test`…). */
  uids?: Partial<Record<'propietario' | 'encargada' | 'camarero' | 'camarera' | 'cocina' | 'barra', string>>
  /** Reloj simulado, solo para pruebas. */
  now?: number
}

type Opening = { quantity: number; valueCents: number } | null
/** [clave, nombre, unidad, categoría, mínimo, objetivo, existencias iniciales y su valor sin IVA] */
const INGREDIENTS: [string, string, 'g' | 'ml' | 'u', string, number, number | null, Opening][] = [
  ['patatas', 'Patatas', 'g', 'Verdura', 8000, 40000, { quantity: 30000, valueCents: 3600 }],
  ['aceite', 'Aceite de oliva', 'ml', 'Despensa', 3000, 15000, { quantity: 2500, valueCents: 1500 }],
  ['huevos', 'Huevos', 'u', 'Despensa', 30, 90, { quantity: 60, valueCents: 1500 }],
  ['brava', 'Salsa brava', 'ml', 'Salsas', 1000, 4000, { quantity: 600, valueCents: 240 }],
  ['alioli', 'Alioli', 'g', 'Salsas', 800, 3000, { quantity: 2000, valueCents: 1000 }],
  ['croquetas', 'Croquetas de jamón', 'u', 'Congelado', 60, 240, { quantity: 200, valueCents: 3600 }],
  ['tomate', 'Tomate', 'g', 'Verdura', 2000, 8000, { quantity: 6000, valueCents: 1500 }],
  ['burrata', 'Burrata', 'u', 'Lácteos', 10, 30, { quantity: 20, valueCents: 3000 }],
  ['entrecot', 'Entrecot de ternera', 'g', 'Carne', 3000, 15000, { quantity: 8000, valueCents: 12800 }],
  ['lubina', 'Lubina', 'g', 'Pescado', 2000, 8000, { quantity: 5000, valueCents: 6000 }],
  ['carne', 'Carne picada de ternera', 'g', 'Carne', 2000, 8000, { quantity: 6000, valueCents: 5400 }],
  ['pan', 'Pan brioche', 'u', 'Panadería', 15, 50, { quantity: 40, valueCents: 1600 }],
  ['cheddar', 'Queso cheddar', 'g', 'Lácteos', 400, 2000, { quantity: 1500, valueCents: 1200 }],
  ['bacon', 'Bacon', 'g', 'Carne', 300, 1500, { quantity: 250, valueCents: 250 }],
  ['pimienta', 'Salsa de pimienta', 'ml', 'Salsas', 300, 1500, { quantity: 1000, valueCents: 800 }],
  ['roquefort', 'Salsa roquefort', 'ml', 'Salsas', 300, 1500, { quantity: 800, valueCents: 960 }],
  ['leche', 'Leche entera', 'ml', 'Lácteos', 3000, 12000, { quantity: 8000, valueCents: 800 }],
  ['tarta', 'Tarta de queso (porción)', 'u', 'Postres', 4, 16, null],
  ['cerveza', 'Cerveza de barril', 'ml', 'Bebidas', 10000, 60000, { quantity: 50000, valueCents: 12500 }],
  ['vino', 'Vino tinto de la casa', 'ml', 'Bebidas', 6000, 24000, { quantity: 20000, valueCents: 14000 }],
  ['agua', 'Agua mineral 50 cl', 'u', 'Bebidas', 24, 96, { quantity: 48, valueCents: 1680 }],
  ['pollo', 'Pollo para asar', 'g', 'Carne', 2000, 8000, { quantity: 6000, valueCents: 3600 }],
]

type Line = [string, number, number]
/** [plato, variante, nombre, líneas [ingrediente, neto por ración, rendimiento en puntos básicos], extras por opción, coste manual] */
const RECIPES: [string, string | null, string, Line[], Record<string, Line[]>, number | null][] = [
  ['bravas', null, 'Patatas bravas', [['patatas', 250, 8500], ['aceite', 40, 10000], ['alioli', 30, 10000], ['brava', 25, 10000]], {}, null],
  ['croquetas', 'media', 'Croquetas, media', [['croquetas', 6, 10000]], {}, null],
  ['croquetas', 'racion', 'Croquetas, ración', [['croquetas', 12, 10000]], {}, null],
  ['ensalada', null, 'Ensalada de tomate y burrata', [['tomate', 200, 9000], ['burrata', 1, 10000], ['aceite', 15, 10000]], {}, null],
  ['entrecot', null, 'Entrecot de ternera', [['entrecot', 300, 9000], ['patatas', 150, 8500], ['aceite', 20, 10000]], { pimienta: [['pimienta', 40, 10000]], roquefort: [['roquefort', 40, 10000]] }, null],
  ['lubina', null, 'Lubina a la brasa', [['lubina', 350, 7000], ['aceite', 20, 10000]], {}, null],
  ['hamburguesa', null, 'Hamburguesa Lumbre', [['carne', 180, 9500], ['pan', 1, 10000], ['patatas', 150, 8500]], { queso: [['cheddar', 20, 10000]], bacon: [['bacon', 30, 10000]] }, null],
  ['crema', null, 'Crema catalana', [['leche', 120, 10000], ['huevos', 2, 10000]], {}, null],
  ['tarta', null, 'Tarta de queso', [['tarta', 1, 10000]], {}, null],
  ['cana', 'cana', 'Cerveza, caña', [['cerveza', 200, 10000]], {}, null],
  ['cana', 'doble', 'Cerveza, doble', [['cerveza', 330, 10000]], {}, null],
  ['cana', 'jarra', 'Cerveza, jarra', [['cerveza', 500, 10000]], {}, null],
  ['vino', 'copa', 'Vino, copa', [['vino', 150, 10000]], {}, null],
  ['vino', 'botella', 'Vino, botella', [['vino', 750, 10000]], {}, null],
  ['agua', null, 'Agua mineral', [['agua', 1, 10000]], {}, null],
  ['sopa', null, 'Sopa de galets', [], {}, 90],
  ['pollo', null, 'Pollo asado', [['pollo', 300, 7500], ['patatas', 150, 8500]], {}, null],
]

/** [clave, nombre, ingrediente, formato, unidades base, precio sin IVA, preferido, proveedor] */
const FORMATS: [string, string, string, number, number, boolean, 'merca' | 'bodegas' | 'carniceria'][] = [
  ['saco-patatas', 'patatas', 'Saco 25 kg', 25000, 3000, true, 'merca'],
  ['garrafa-aceite', 'aceite', 'Garrafa 5 l', 5000, 2800, true, 'merca'],
  ['caja-tomate', 'tomate', 'Caja 6 kg', 6000, 1500, true, 'merca'],
  ['huevos', 'huevos', 'Cubeta 30 uds', 30, 700, true, 'merca'],
  ['leche', 'leche', 'Pack 6 l', 6000, 540, true, 'merca'],
  ['entrecot', 'entrecot', 'Bandeja 2 kg', 2000, 3400, true, 'carniceria'],
  ['carne', 'carne', 'Bolsa 2 kg', 2000, 1800, true, 'carniceria'],
  ['bacon', 'bacon', 'Paquete 1 kg', 1000, 1000, true, 'carniceria'],
  ['barril', 'cerveza', 'Barril 30 l', 30000, 7500, true, 'bodegas'],
  ['vino', 'vino', 'Caja 6 botellas', 4500, 2700, true, 'bodegas'],
  ['agua', 'agua', 'Pack 24 uds', 24, 840, true, 'bodegas'],
]

export async function seedFase4(target: SeedTarget = { restaurantId: 'demo-lumbre', locationId: 'centro' }) {
  localOnly()
  const rid = target.restaurantId, lid = target.locationId
  const scope = { restaurantId: rid, locationId: lid }
  const root = db.doc(`restaurants/${rid}`)
  const restaurant = (await root.get()).data()
  if (!restaurant) throw new Error('Ejecuta primero pnpm seed.')
  const modules = core.restaurantModules(restaurant)
  await root.update({ plan: 'completo', activeModules: [...new Set([...modules, 'staff', 'inventory'])] })
  if (!(await db.doc(`${root.path}/locations/${lid}/menuItems/bravas`).get()).exists) throw new Error('Falta la carta de demostración: ejecuta pnpm seed.')

  const auth = getAuth()
  const uidOf = async (key: keyof NonNullable<SeedTarget['uids']>) => target.uids?.[key] ?? (await auth.getUserByEmail(`${key}@lumbre.test`)).uid
  const owner = await uidOf('propietario'), manager = await uidOf('encargada')
  const people = { camarero: await uidOf('camarero'), camarera: await uidOf('camarera'), cocina: await uidOf('cocina'), barra: await uidOf('barra'), encargada: manager }
  const as = (uid: string) => ({ data: null, auth: { uid, token: {} } }) as unknown as CallableRequest<unknown>
  const run = <N extends Name>(name: N, uid: string, key: string, data: object, now?: number) =>
    execute(name, { ...scope, ...(name === 'sugerirPedidos' ? {} : { requestId: `seed4-${key}` }), ...data }, as(uid), { now: now ?? target.now })
  const now = target.now ?? Date.now()
  const tz: string = restaurant.timezone ?? 'Europe/Madrid'
  const today = core.horaLocal(now, tz).fecha

  /* Personal ---------------------------------------------------------------------------------- */
  await run('guardarConfiguracionPersonal', owner, 'personal-ajustes', { settings: { ...core.defaultStaffSettings(), kioskEnabled: true } })
  for (const [key, pin] of [['camarero', '1234'], ['camarera', '2345'], ['cocina', '3456'], ['barra', '4567']] as const) {
    // El PIN guarda una sal aleatoria: se evita repetirlo si ya existe.
    if (!(await db.doc(`${root.path}/locations/${lid}/staffPins/${people[key]}`).get()).exists) await run('guardarPinFichaje', owner, `pin-${key}`, { uid: people[key], pin })
  }
  // Seis días de fichajes ya pasados, con pausas y turnos de noche que cruzan la medianoche.
  const plan: [keyof typeof people, number, number, number | null, number | null][] = [
    // persona, entrada (minutos desde las 00:00), salida (puede pasar de 1440), inicio y fin de pausa
    ['camarero', 13 * 60, 17 * 60 + 30, 16 * 60, 16 * 60 + 30],
    ['camarera', 20 * 60, 24 * 60 + 40, 22 * 60 + 30, 23 * 60],
    ['cocina', 11 * 60, 16 * 60 + 30, 14 * 60 + 30, 15 * 60],
    ['barra', 18 * 60, 26 * 60 + 10, 22 * 60, 22 * 60 + 40],
    ['encargada', 10 * 60, 18 * 60, 14 * 60, 14 * 60 + 45],
  ]
  for (let back = 6; back >= 1; back--) {
    const date = core.sumarDias(today, -back)
    for (const [i, [who, start, end, b0, b1]] of plan.entries()) {
      // Cada persona libra un día distinto de la semana.
      if ((back + i) % 7 === 0) continue
      const at = (m: number) => core.instanteDeHoraLocal(core.sumarDias(date, Math.floor(m / 1440)), m % 1440, tz)
      const [startAt, endAt] = [at(start), at(end)]
      if (startAt === null || endAt === null || endAt > now - MIN) continue
      const breaks = b0 !== null && b1 !== null && at(b0) !== null && at(b1) !== null ? [{ startAt: at(b0)!, endAt: at(b1)! }] : []
      await run('crearFichajeManual', manager, `fichaje-${date}-${who}`, { uid: people[who], startAt, endAt, breaks, reason: 'Datos de demostración' })
    }
  }
  // Un fichaje que se quedó abierto hace dos días: lo marca el proceso de revisión y lo cierra un encargado.
  const ghost = core.instanteDeHoraLocal(core.sumarDias(today, -2), 17 * 60 + 5, tz)
  const oldEntry = db.doc(`${root.path}/locations/${lid}/timeEntries/seed4-olvidado`)
  if (ghost !== null && !(await oldEntry.get()).exists && !(await db.doc(`${root.path}/staffClockLocks/${people.camarera}`).get()).exists) {
    const entry = core.TimeEntrySchema.parse({
      uid: people.camarera, date: core.sumarDias(today, -2), startAt: ghost, endAt: null, breaks: [], status: 'open', startSource: 'self', endSource: null,
      shiftId: null, forgotten: true, needsReview: false, workedMinutes: null, breakMinutes: 0, note: null, revision: 2,
    })
    const event = core.TimeEntryEventSchema.parse({ entryId: 'seed4-olvidado', uid: people.camarera, kind: 'clock_in', at: ghost, by: people.camarera, source: 'self', reason: null, before: null, after: { startAt: ghost, endAt: null, breaks: [] } })
    const stamp = { createdAt: Timestamp.now(), updatedAt: Timestamp.now(), updatedBy: null }
    await db.runTransaction(async (tx) => {
      tx.create(oldEntry, { ...core.timeEntryForWrite(entry, Timestamp.fromMillis), ...stamp })
      tx.create(db.doc(`${root.path}/locations/${lid}/timeEntryEvents/seed4-olvidado`), { ...core.timeEntryEventForWrite(event, Timestamp.fromMillis), ...stamp })
      tx.set(db.doc(`${root.path}/staffClockLocks/${people.camarera}`), { locationId: lid, entryId: 'seed4-olvidado', ...stamp })
    })
  }
  // Cuadrante: la semana en curso publicada y la siguiente en borrador.
  const monday = core.weekStartOf(today)
  const shifts: [keyof typeof people, number, number, number, string][] = [
    // persona, día de la semana (0 = lunes), entrada y salida en minutos, puesto
    ['camarero', 1, 12 * 60 + 30, 17 * 60 + 30, 'Sala'], ['camarero', 2, 12 * 60 + 30, 17 * 60 + 30, 'Sala'], ['camarero', 4, 12 * 60 + 30, 24 * 60, 'Sala'], ['camarero', 5, 12 * 60 + 30, 24 * 60, 'Sala'],
    ['camarera', 2, 19 * 60 + 30, 24 * 60 + 30, 'Sala'], ['camarera', 3, 19 * 60 + 30, 24 * 60 + 30, 'Sala'], ['camarera', 4, 19 * 60 + 30, 24 * 60 + 30, 'Terraza'], ['camarera', 5, 19 * 60 + 30, 24 * 60 + 30, 'Terraza'],
    ['cocina', 1, 11 * 60, 16 * 60 + 30, 'Cocina'], ['cocina', 2, 11 * 60, 23 * 60 + 30, 'Cocina'], ['cocina', 4, 11 * 60, 23 * 60 + 30, 'Cocina'], ['cocina', 5, 11 * 60, 23 * 60 + 30, 'Cocina'],
    ['barra', 3, 18 * 60, 24 * 60 + 30, 'Barra'], ['barra', 4, 18 * 60, 26 * 60, 'Barra'], ['barra', 5, 18 * 60, 26 * 60, 'Barra'], ['barra', 6, 12 * 60, 18 * 60, 'Barra'],
    ['encargada', 0, 10 * 60, 18 * 60, 'Encargo'], ['encargada', 2, 10 * 60, 18 * 60, 'Encargo'], ['encargada', 4, 16 * 60, 24 * 60, 'Encargo'],
  ]
  for (const [week, publish] of [[monday, true], [core.sumarDias(monday, 7), false]] as const) {
    for (const [who, day, start, end, position] of shifts) {
      const date = core.sumarDias(week, day)
      const at = (m: number) => core.instanteDeHoraLocal(core.sumarDias(date, Math.floor(m / 1440)), m % 1440, tz)
      const [startAt, endAt] = [at(start), at(end)]
      if (startAt === null || endAt === null) continue
      await run('guardarTurno', manager, `turno-${date}-${who}`, { shiftId: null, expectedRevision: null, shift: { uid: people[who], startAt, endAt, position, note: '' } })
    }
    if (publish) await run('publicarCuadrante', manager, `publicar-${week}`, { weekStart: week, publish: true })
  }

  /* Inventario -------------------------------------------------------------------------------- */
  await run('guardarConfiguracionInventario', owner, 'inventario-ajustes', { settings: core.defaultInventorySettings() })
  const ing: Record<string, string> = {}
  for (const [key, name, unit, category, minQuantity, targetQuantity, opening] of INGREDIENTS) {
    ing[key] = (await run('guardarIngrediente', manager, `ingrediente-${key}`, {
      ingredientId: null, expectedRevision: null, ingredient: { name, unit, category, minQuantity, targetQuantity, active: true }, opening,
    })).ingredientId
  }
  for (const [itemId, variantId, name, lines, options, manualCostCents] of RECIPES) {
    const convert = (ls: Line[]) => ls.map(([k, quantity, yieldBp]) => ({ ingredientId: ing[k]!, quantity, yieldBp }))
    await run('guardarReceta', manager, `receta-${itemId}-${variantId ?? 'base'}`, {
      recipeId: null, expectedVersion: null,
      recipe: { name, itemId, variantId, lines: convert(lines), optionLines: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, convert(v)])), manualCostCents, active: true },
    })
  }
  // Un poco de merma reciente, como la apuntaría la cocina.
  await run('registrarMerma', people.cocina, 'merma-huevos', { ingredientId: ing.huevos!, quantity: 4, wasteReason: 'broken', reason: 'Se cayó una cubeta' })
  await run('registrarMerma', people.cocina, 'merma-tomate', { ingredientId: ing.tomate!, quantity: 400, wasteReason: 'spoiled', reason: null })

  /* Compras ----------------------------------------------------------------------------------- */
  const supplierIds: Record<string, string> = {}
  for (const [key, name, contact, leadDays, minOrderCents] of [
    ['merca', 'Distribuciones Mercabarna', 'Rosa Vidal', 1, 6000], ['bodegas', 'Bodegas Costa', 'Jordi Costa', 2, 8000], ['carniceria', 'Carnicería Vidal', 'Antoni Vidal', 1, 3000],
  ] as const) {
    supplierIds[key] = (await run('guardarProveedor', manager, `proveedor-${key}`, { supplierId: null, supplier: { name, phone: null, email: null, contact, leadDays, minOrderCents, notes: 'Proveedor de demostración', active: true } })).supplierId
  }
  const fmt: Record<string, string> = {}
  for (const [key, ingredient, name, baseQuantity, priceCents, preferred, supplier] of FORMATS) {
    fmt[key] = (await run('guardarFormatoProveedor', manager, `formato-${key}`, {
      itemId: null, item: { supplierId: supplierIds[supplier]!, ingredientId: ing[ingredient]!, name, sku: null, baseQuantity, priceCents, preferred, active: true },
    })).itemId
  }
  const sent = await run('guardarPedidoProveedor', manager, 'pedido-a', {
    orderId: null, expectedRevision: null, supplierId: supplierIds.merca!, lines: [{ supplierItemId: fmt['saco-patatas']!, formats: 2 }, { supplierItemId: fmt['garrafa-aceite']!, formats: 2 }, { supplierItemId: fmt['caja-tomate']!, formats: 1 }],
    expectedOn: core.sumarDias(today, 1), notes: 'Entregar antes de las 10:00',
  })
  await run('cambiarEstadoPedidoProveedor', manager, 'pedido-a-enviado', { orderId: sent.orderId, expectedRevision: sent.revision, to: 'sent', reason: null })
  // Llega la mitad y la patata sube un 3 %: queda recibido en parte y con aviso de precio.
  await run('recibirPedidoProveedor', manager, 'recepcion-a1', {
    supplierId: supplierIds.merca!, purchaseOrderId: sent.orderId, expectedRevision: sent.revision + 1, deliveryNote: 'ALB-2041',
    lines: [{ supplierItemId: fmt['saco-patatas']!, receivedFormats: 1, priceCents: 3100 }, { supplierItemId: fmt['caja-tomate']!, receivedFormats: 1, priceCents: 1500 }],
  })
  await run('guardarPedidoProveedor', manager, 'pedido-b', {
    orderId: null, expectedRevision: null, supplierId: supplierIds.carniceria!, lines: [{ supplierItemId: fmt.entrecot!, formats: 3 }, { supplierItemId: fmt.carne!, formats: 2 }], expectedOn: null, notes: '',
  })
  return { restaurantId: rid, locationId: lid, ingredients: Object.keys(ing).length, recipes: RECIPES.length, suppliers: Object.keys(supplierIds).length, pins: 'Diego 1234 · Lucía 2345 · Pau 3456 · Nora 4567' }
}
