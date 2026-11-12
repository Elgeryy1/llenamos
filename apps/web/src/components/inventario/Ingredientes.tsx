"use client"

import { BasketIcon, PencilSimpleIcon, PlusIcon } from "@phosphor-icons/react"
import type { IngredientWithId } from "@llenamos/core"
import { useState } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { useIngredientes } from "@/lib/inventario/datos"
import { categoriasDe, textoCantidad } from "@/lib/inventario/modelo"
import { IngredienteDialog } from "./IngredienteDialog"
import { Cargado, useLocalInventario } from "./piezas"

export function Ingredientes() {
  return (
    <RequirePermission permission="inventario.gestionar" what="los ingredientes">
      <Lista />
    </RequirePermission>
  )
}

function Lista() {
  const { base, alcance } = useLocalInventario()
  const ingredientes = useIngredientes(base)
  const [edicion, setEdicion] = useState<{ ingrediente: IngredientWithId | null } | null>(null)
  if (!alcance) return null
  return (
    <Cargado live={ingredientes} label="los ingredientes">
      {(lista) => {
        const ordenados = [...lista].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, "es"))
        return (
          <div className="flex flex-col gap-5">
            <div className="flex justify-end">
              <Button size="xl" onClick={() => setEdicion({ ingrediente: null })}>
                <PlusIcon aria-hidden />
                Nuevo ingrediente
              </Button>
            </div>
            {ordenados.length === 0 ? (
              <EmptyState icon={<BasketIcon />} title="Aún no hay ingredientes" description="Crea el primero con su unidad y, si quieres, lo que hay hoy en el almacén." />
            ) : (
              <ul className="superficie divide-y overflow-hidden" aria-label="Ingredientes">
                {ordenados.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <span className="text-base font-medium">{i.name}</span>
                        {!i.active ? <Tag>Apagado</Tag> : null}
                      </p>
                      <p className="mt-0.5 text-sm text-muted-foreground">
                        {i.category ?? "Sin categoría"} · en {i.unit === "u" ? "unidades" : i.unit === "g" ? "gramos" : "mililitros"} · aviso a partir de {i.minQuantity > 0 ? textoCantidad(i.minQuantity, i.unit) : "nunca"}
                        {i.targetQuantity !== null ? ` · repone hasta ${textoCantidad(i.targetQuantity, i.unit)}` : ""}
                      </p>
                    </div>
                    <div className="flex items-center gap-4">
                      <span className="cifra text-lg">{textoCantidad(i.quantity, i.unit)}</span>
                      <Button variant="outline" className="pointer-coarse:h-11" onClick={() => setEdicion({ ingrediente: i })}>
                        <PencilSimpleIcon aria-hidden />
                        Editar<span className="sr-only">: {i.name}</span>
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {edicion ? (
              <IngredienteDialog key={edicion.ingrediente?.id ?? "nuevo"} alcance={alcance} ingrediente={edicion.ingrediente} categorias={categoriasDe(lista)} onClose={() => setEdicion(null)} />
            ) : null}
          </div>
        )
      }}
    </Cargado>
  )
}
