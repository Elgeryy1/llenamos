"use client"

/**
 * Lecturas en directo del almacén y los escandallos. Cada colección se lee con su esquema de
 * `@llenamos/core`; si un documento no lo cumple se enseña el error, no se rellena nada.
 * Las reglas son las de ARQUITECTURA.md: cocina y barra leen `ingredients` y `stockAlerts`;
 * costes, movimientos, recetas y recuentos solo quien ve costes (`inventoryManager`).
 *
 * Con `NEXT_PUBLIC_DATA_BACKEND=postgres` cada lectura es una `useLiveQuery` por nombre contra la API del
 * VPS (mismos esquemas de core) y no se abre ninguna escucha de Firestore. Sin él, sigue la demo.
 */
import {
  INVENTARIO_LIVE,
  InventarioAjustesOutputSchema,
  InventarioCostesOutputSchema,
  InventarioMovimientosOutputSchema,
  InventarioPlatosOutputSchema,
  InventarioRecetasOutputSchema,
  InventarioRecuentosOutputSchema,
  InventarioStockOutputSchema,
  InventarioVersionesOutputSchema,
  IngredientCostSchema,
  IngredientSchema,
  InventorySettingsSchema,
  MenuItemSchema,
  RecipeSchema,
  RecipeVersionSchema,
  StockAlertSchema,
  StockCountSchema,
  StockMovementSchema,
  defaultInventorySettings,
  type IngredientCost,
  type IngredientWithId,
  type InventorySettings,
  type RecipeVersion,
  type RecipeWithId,
  type StockAlert,
  type StockCount,
  type StockMovement,
} from "@llenamos/core"
import type { z } from "zod"
import { DataShapeError } from "@/lib/data/parse"
import { useLiveQuery as useLiveApi } from "@/lib/api/live"
import { useLiveDoc, useLiveQuery, type Live } from "@/lib/fase4/demo"
import { alcanceDeRuta, mapLive, modoVps, useEntrada } from "@/lib/fase4/vivo"
import type { ConId, PlatoDoc } from "./modelo"

export function rutaLocal(restaurantId: string, locationId: string | null): string | null {
  return locationId ? `restaurants/${restaurantId}/locations/${locationId}` : null
}

function leer<S extends z.ZodType>(schema: S, path: string, data: unknown): z.output<S> {
  const r = schema.safeParse(data)
  if (!r.success) throw new DataShapeError(path, r.error.issues.map((i) => i.path.join(".")))
  return r.data
}

function useColeccion<S extends z.ZodType>(base: string | null, nombre: string, schema: S, activo = true): Live<ConId<z.output<S>>[]> {
  const ruta = base ? `${base}/${nombre}` : null
  return useLiveQuery(
    ruta && activo ? `inv:${ruta}` : null,
    (db, fs) => fs.query(fs.collection(db, ruta!)),
    (id, data) => ({ ...(leer(schema, `${ruta}/${id}`, data) as object), id }) as ConId<z.output<S>>,
  )
}

export function useIngredientes(base: string | null): Live<IngredientWithId[]> {
  const vps = modoVps()
  const demo = useColeccion(vps ? null : base, "ingredients", IngredientSchema) as Live<IngredientWithId[]>
  const api = useLiveApi(INVENTARIO_LIVE.stock, useEntrada(vps, alcanceDeRuta(base)), InventarioStockOutputSchema)
  return vps ? mapLive(api, (r) => r.ingredients as IngredientWithId[]) : demo
}

/** Avisos de stock por ingrediente (el id del aviso es el del ingrediente). */
export function useAvisos(base: string | null): Live<Map<string, StockAlert>> {
  const vps = modoVps()
  const lista = useColeccion(vps ? null : base, "stockAlerts", StockAlertSchema)
  const demo = mapear(lista, (xs) => new Map(xs.map(({ id, ...a }) => [id, a as StockAlert])))
  const api = useLiveApi(INVENTARIO_LIVE.stock, useEntrada(vps, alcanceDeRuta(base)), InventarioStockOutputSchema)
  return vps ? mapLive(api, (r) => new Map(r.alerts.map(({ id, ...a }) => [id, a as StockAlert]))) : demo
}

export function useCostes(base: string | null, activo: boolean): Live<Map<string, IngredientCost>> {
  const vps = modoVps()
  const lista = useColeccion(vps ? null : base, "ingredientCosts", IngredientCostSchema, activo)
  const demo = mapear(lista, (xs) => new Map(xs.map(({ id, ...c }) => [id, c as IngredientCost])))
  const api = useLiveApi(INVENTARIO_LIVE.costes, useEntrada(vps && activo, alcanceDeRuta(base)), InventarioCostesOutputSchema)
  return vps ? mapLive(api, (r) => new Map(r.costs.map(({ id, ...c }) => [id, c as IngredientCost]))) : demo
}

/** Platos de la carta: en el VPS los sirve el módulo de inventario leyendo la carta de sala. */
export function usePlatos(base: string | null, activo = true): Live<PlatoDoc[]> {
  const vps = modoVps()
  const demo = useColeccion(vps ? null : base, "menuItems", MenuItemSchema, activo) as Live<PlatoDoc[]>
  const api = useLiveApi(INVENTARIO_LIVE.platos, useEntrada(vps && activo, alcanceDeRuta(base)), InventarioPlatosOutputSchema)
  return vps ? mapLive(api, (r) => r.items as PlatoDoc[]) : demo
}

export function useRecetas(base: string | null, activo = true): Live<RecipeWithId[]> {
  const vps = modoVps()
  const demo = useColeccion(vps ? null : base, "recipes", RecipeSchema, activo) as Live<RecipeWithId[]>
  const api = useLiveApi(INVENTARIO_LIVE.recetas, useEntrada(vps && activo, alcanceDeRuta(base)), InventarioRecetasOutputSchema)
  return vps ? mapLive(api, (r) => r.recipes as RecipeWithId[]) : demo
}

export function useAjustesInventario(base: string | null, activo = true): Live<{ guardado: boolean; ajustes: InventorySettings }> {
  const vps = modoVps()
  const ruta = !vps && base ? `${base}/settings/inventory` : null
  const demo = useLiveDoc(ruta && activo ? ruta : null, (_id, data) => ({
    guardado: data !== undefined,
    ajustes: data === undefined ? defaultInventorySettings() : leer(InventorySettingsSchema, ruta!, data),
  }))
  const api = useLiveApi(INVENTARIO_LIVE.ajustes, useEntrada(vps && activo, alcanceDeRuta(base)), InventarioAjustesOutputSchema)
  return vps ? mapLive(api, (r) => ({ guardado: r.saved, ajustes: r.settings })) : demo
}

export function useRecuentos(base: string | null): Live<ConId<StockCount>[]> {
  const vps = modoVps()
  const ruta = !vps && base ? `${base}/stockCounts` : null
  const demo = useLiveQuery(
    ruta ? `inv:counts:${ruta}` : null,
    (db, fs) => fs.query(fs.collection(db, ruta!), fs.orderBy("startedAt", "desc"), fs.limit(30)),
    (id, data) => ({ ...leer(StockCountSchema, `${ruta}/${id}`, data), id }),
  )
  const api = useLiveApi(INVENTARIO_LIVE.recuentos, useEntrada(vps, alcanceDeRuta(base)), InventarioRecuentosOutputSchema)
  return vps ? mapLive(api, (r) => r.counts as ConId<StockCount>[]) : demo
}

/** Últimos movimientos del libro, todos o de un ingrediente. */
export function useMovimientos(base: string | null, max: number, ingredientId: string | null = null): Live<ConId<StockMovement>[]> {
  const vps = modoVps()
  const ruta = !vps && base ? `${base}/stockMovements` : null
  const demo = useLiveQuery(
    ruta ? `inv:mov:${ruta}:${max}:${ingredientId ?? "*"}` : null,
    (db, fs) => {
      const col = fs.collection(db, ruta!)
      return ingredientId
        ? fs.query(col, fs.where("ingredientId", "==", ingredientId), fs.orderBy("at", "desc"), fs.limit(max))
        : fs.query(col, fs.orderBy("at", "desc"), fs.limit(max))
    },
    (id, data) => ({ ...leer(StockMovementSchema, `${ruta}/${id}`, data), id }),
  )
  const alcance = alcanceDeRuta(base)
  const api = useLiveApi(INVENTARIO_LIVE.movimientos, useEntrada(vps, alcance && { ...alcance, max: Math.min(Math.max(1, max), 2000), ingredientId, since: null }), InventarioMovimientosOutputSchema)
  return vps ? mapLive(api, (r) => r.movements as ConId<StockMovement>[]) : demo
}

/** Movimientos desde un instante, para enseñar qué ha pasado mientras se cuenta. */
export function useMovimientosDesde(base: string | null, desde: number | null): Live<ConId<StockMovement>[]> {
  const vps = modoVps()
  const ruta = !vps && base ? `${base}/stockMovements` : null
  const demo = useLiveQuery(
    ruta && desde !== null ? `inv:movdesde:${ruta}:${desde}` : null,
    (db, fs) => fs.query(fs.collection(db, ruta!), fs.where("at", ">=", fs.Timestamp.fromMillis(desde!)), fs.orderBy("at", "asc"), fs.limit(2000)),
    (id, data) => ({ ...leer(StockMovementSchema, `${ruta}/${id}`, data), id }),
  )
  const alcance = alcanceDeRuta(base)
  const api = useLiveApi(INVENTARIO_LIVE.movimientos, useEntrada(vps && desde !== null, alcance && desde !== null ? { ...alcance, max: 2000, ingredientId: null, since: desde } : null), InventarioMovimientosOutputSchema)
  return vps ? mapLive(api, (r) => r.movements as ConId<StockMovement>[]) : demo
}

export function useVersiones(base: string | null, recipeId: string | null): Live<RecipeVersion[]> {
  const vps = modoVps()
  const ruta = !vps && base && recipeId ? `${base}/recipes/${recipeId}/versions` : null
  const demo = useLiveQuery(
    ruta ? `inv:ver:${ruta}` : null,
    (db, fs) => fs.query(fs.collection(db, ruta!), fs.orderBy("version", "desc"), fs.limit(20)),
    (id, data) => leer(RecipeVersionSchema, `${ruta}/${id}`, data),
  )
  const alcance = alcanceDeRuta(base)
  const api = useLiveApi(INVENTARIO_LIVE.versiones, useEntrada(vps && recipeId !== null, alcance && recipeId ? { ...alcance, recipeId } : null), InventarioVersionesOutputSchema)
  return vps ? mapLive(api, (r) => r.versions) : demo
}

function mapear<A, B>(live: Live<A>, f: (a: A) => B): Live<B> {
  if (live.status !== "ready") return live
  try {
    return { status: "ready", data: f(live.data) }
  } catch (error) {
    return { status: "error", error }
  }
}

/** Junta varias lecturas: la primera con error manda, luego cualquier carga, y si no, todas listas. */
export function juntar<T extends Record<string, Live<unknown>>>(lecturas: T): Live<{ [K in keyof T]: T[K] extends Live<infer D> ? D : never }> {
  const valores = Object.values(lecturas)
  const fallo = valores.find((l) => l.status === "error")
  if (fallo) return fallo as Live<never>
  if (valores.some((l) => l.status === "loading")) return { status: "loading" }
  return { status: "ready", data: Object.fromEntries(Object.entries(lecturas).map(([k, l]) => [k, (l as { data: unknown }).data])) as never }
}
