"use client"

import type { IngredientWithId, SupplierItemWithId, SupplierWithId } from "@llenamos/core"
import { useMemo } from "react"
import { useFormatos, useIngredientes, useProveedores, type Scope } from "@/lib/compras/datos"

const porId = <T extends { id: string }>(xs: T[]) => new Map(xs.map((x) => [x.id, x]))

/** Proveedores, formatos e ingredientes del local, en directo y ya indexados por id. */
export function useBase(scope: Scope) {
  const proveedores = useProveedores(scope)
  const formatos = useFormatos(scope)
  const ingredientes = useIngredientes(scope)
  const listos = proveedores.status === "ready" && formatos.status === "ready" && ingredientes.status === "ready"
  const err = [proveedores, formatos, ingredientes].find((l) => l.status === "error")
  const datos = useMemo(() => {
    if (!(proveedores.status === "ready" && formatos.status === "ready" && ingredientes.status === "ready")) return null
    const ordenados = {
      proveedores: proveedores.data.toSorted((a, b) => a.name.localeCompare(b.name, "es")),
      formatos: formatos.data.toSorted((a, b) => a.name.localeCompare(b.name, "es")),
      ingredientes: ingredientes.data.toSorted((a, b) => a.name.localeCompare(b.name, "es")),
    }
    return {
      ...ordenados,
      proveedorPorId: porId<SupplierWithId>(ordenados.proveedores),
      formatoPorId: porId<SupplierItemWithId>(ordenados.formatos),
      ingredientePorId: porId<IngredientWithId>(ordenados.ingredientes),
    }
  }, [proveedores, formatos, ingredientes])
  return { listos, error: err && err.status === "error" ? err.error : null, datos }
}
export type Base = NonNullable<ReturnType<typeof useBase>["datos"]>
