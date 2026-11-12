"use client"

import {
  ComprasAlbaranesOutputSchema,
  ComprasIngredientesOutputSchema,
  ComprasPedidosOutputSchema,
  ComprasProveedoresOutputSchema,
  GoodsReceiptSchema,
  INVENTARIO_LIVE,
  IngredientSchema,
  PurchaseOrderSchema,
  SupplierItemSchema,
  SupplierSchema,
  type GoodsReceipt,
  type IngredientWithId,
  type PurchaseOrderWithId,
  type SupplierItemWithId,
  type SupplierWithId,
} from "@llenamos/core"
import { useLiveQuery as useLiveApi } from "@/lib/api/live"
import { useLiveQuery, type Live } from "@/lib/fase4/demo"
import { mapLive, modoVps, useEntrada } from "@/lib/fase4/vivo"

export interface Scope {
  restaurantId: string
  locationId: string
}
const base = (s: Scope) => `restaurants/${s.restaurantId}/locations/${s.locationId}`

/**
 * Todas las lecturas piden lo que piden las reglas: miembro, local y módulo de inventario con `compras.gestionar`.
 * Con `NEXT_PUBLIC_DATA_BACKEND=postgres` salen de la API del VPS y Firestore no se escucha.
 */
function useCompras<D, S extends { parse: (v: unknown) => unknown }>(
  scope: Scope, nombre: string, schema: S, extra: object = {}, demo: Live<D>,
): { vps: boolean; api: Live<ReturnType<S["parse"]>>; demo: Live<D> } {
  const vps = modoVps()
  const api = useLiveApi(nombre, useEntrada(vps, { restaurantId: scope.restaurantId, locationId: scope.locationId, ...extra }), schema as never) as Live<ReturnType<S["parse"]>>
  return { vps, api, demo }
}

export function useProveedores(scope: Scope): Live<SupplierWithId[]> {
  const path = `${base(scope)}/suppliers`
  const demo = useLiveQuery(modoVps() ? null : path, (db, fs) => fs.query(fs.collection(db, path)), (id, data) => ({ id, ...SupplierSchema.parse(data) }))
  const r = useCompras(scope, INVENTARIO_LIVE.proveedores, ComprasProveedoresOutputSchema, {}, demo)
  return r.vps ? mapLive(r.api, (x) => x.suppliers as SupplierWithId[]) : demo
}

export function useFormatos(scope: Scope): Live<SupplierItemWithId[]> {
  const path = `${base(scope)}/supplierItems`
  const demo = useLiveQuery(modoVps() ? null : path, (db, fs) => fs.query(fs.collection(db, path)), (id, data) => ({ id, ...SupplierItemSchema.parse(data) }))
  const r = useCompras(scope, INVENTARIO_LIVE.proveedores, ComprasProveedoresOutputSchema, {}, demo)
  return r.vps ? mapLive(r.api, (x) => x.items as SupplierItemWithId[]) : demo
}

export function useIngredientes(scope: Scope): Live<IngredientWithId[]> {
  const path = `${base(scope)}/ingredients`
  const demo = useLiveQuery(modoVps() ? null : path, (db, fs) => fs.query(fs.collection(db, path)), (id, data) => ({ id, ...IngredientSchema.parse(data) }))
  const r = useCompras(scope, INVENTARIO_LIVE.ingredientesCompras, ComprasIngredientesOutputSchema, {}, demo)
  return r.vps ? mapLive(r.api, (x) => x.ingredients as IngredientWithId[]) : demo
}

/** Los 200 pedidos más recientes (por creación). */
export function usePedidos(scope: Scope): Live<PurchaseOrderWithId[]> {
  const path = `${base(scope)}/purchaseOrders`
  const demo = useLiveQuery(
    modoVps() ? null : `${path}?recientes`,
    (db, fs) => fs.query(fs.collection(db, path), fs.orderBy("createdAt", "desc"), fs.limit(200)),
    (id, data) => ({ id, ...PurchaseOrderSchema.parse(data) }),
  )
  const r = useCompras(scope, INVENTARIO_LIVE.pedidos, ComprasPedidosOutputSchema, {}, demo)
  return r.vps ? mapLive(r.api, (x) => x.orders as PurchaseOrderWithId[]) : demo
}

export type Albaran = GoodsReceipt & { id: string }

/** Albaranes: los últimos del local o los de un pedido. */
export function useAlbaranes(scope: Scope, orderId: string | null = null): Live<Albaran[]> {
  const path = `${base(scope)}/goodsReceipts`
  const key = orderId ? `${path}?pedido=${orderId}` : `${path}?recientes`
  const demo = useLiveQuery(
    modoVps() ? null : key,
    (db, fs) =>
      orderId
        ? fs.query(fs.collection(db, path), fs.where("purchaseOrderId", "==", orderId))
        : fs.query(fs.collection(db, path), fs.orderBy("receivedAt", "desc"), fs.limit(15)),
    (id, data) => ({ id, ...GoodsReceiptSchema.parse(data) }),
  )
  const r = useCompras(scope, INVENTARIO_LIVE.albaranes, ComprasAlbaranesOutputSchema, { orderId }, demo)
  return r.vps ? mapLive(r.api, (x) => x.receipts as Albaran[]) : demo
}

/** Estado de varias lecturas a la vez: carga si alguna carga, error si alguna falla. */
export function juntar(...lives: Live<unknown>[]): { status: "loading" } | { status: "error"; error: unknown } | { status: "ready" } {
  const error = lives.find((l) => l.status === "error")
  if (error && error.status === "error") return { status: "error", error: error.error }
  if (lives.some((l) => l.status === "loading")) return { status: "loading" }
  return { status: "ready" }
}
