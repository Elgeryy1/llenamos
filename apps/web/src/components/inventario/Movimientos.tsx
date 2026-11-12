"use client"

import { ListMagnifyingGlassIcon } from "@phosphor-icons/react"
import { MOVEMENT_KINDS, MOVEMENT_KIND_LABEL, WASTE_REASON_LABEL, type IngredientWithId, type MovementKind } from "@llenamos/core"
import { useState } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { SelectField } from "@/components/common/form-fields"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { usePanel } from "@/components/panel/PanelContext"
import { useMembers } from "@/lib/data/hooks"
import { useIngredientes, useMovimientos } from "@/lib/inventario/datos"
import { euros, textoCantidad } from "@/lib/inventario/modelo"
import { Cargado, useLocalInventario } from "./piezas"

export function Movimientos() {
  return (
    <RequirePermission permission="costes.ver" what="los movimientos del almacén">
      <Libro />
    </RequirePermission>
  )
}

const formatoHora = (ms: number, timezone: string) =>
  new Intl.DateTimeFormat("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: timezone }).format(ms)

function Libro() {
  const { base, timezone } = useLocalInventario()
  const { restaurant } = usePanel()
  const [max, setMax] = useState(100)
  const [ingredienteId, setIngredienteId] = useState("")
  const [tipo, setTipo] = useState<MovementKind | "">("")
  const ingredientes = useIngredientes(base)
  const movimientos = useMovimientos(base, max, ingredienteId || null)
  const miembros = useMembers(restaurant.id)
  const nombres = new Map(miembros.status === "ready" ? miembros.data.map((m) => [m.uid, m.displayName]) : [])
  return (
    <Cargado live={ingredientes} label="los ingredientes">
      {(lista) => {
        const porId = new Map<string, IngredientWithId>(lista.map((i) => [i.id, i]))
        return (
          <div className="flex flex-col gap-5">
            <div className="superficie flex flex-col gap-3 p-4 sm:flex-row sm:items-end">
              <SelectField label="Ingrediente" fieldClassName="sm:w-64" value={ingredienteId} onChange={(e) => setIngredienteId(e.target.value)}>
                <option value="">Todos</option>
                {lista.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
              </SelectField>
              <SelectField label="Tipo de movimiento" fieldClassName="sm:w-64" value={tipo} onChange={(e) => setTipo(e.target.value as MovementKind | "")}>
                <option value="">Todos</option>
                {MOVEMENT_KINDS.map((k) => <option key={k} value={k}>{MOVEMENT_KIND_LABEL[k]}</option>)}
              </SelectField>
            </div>
            <Cargado live={movimientos} label="los movimientos">
              {(todos) => {
                const filas = todos.filter((m) => tipo === "" || m.kind === tipo)
                if (filas.length === 0) {
                  return <EmptyState icon={<ListMagnifyingGlassIcon />} title="Sin movimientos" description="Cuando se venda, se reciba o se apunte merma, aparecerá aquí." />
                }
                return (
                  <>
                    <div className="superficie overflow-x-auto">
                      <table className="w-full min-w-[46rem] text-sm">
                        <caption className="sr-only">Libro de movimientos del almacén</caption>
                        <thead>
                          <tr className="border-b text-left text-xs text-muted-foreground">
                            <th scope="col" className="px-4 py-3 font-medium">Cuándo</th>
                            <th scope="col" className="px-2 py-3 font-medium">Ingrediente</th>
                            <th scope="col" className="px-2 py-3 font-medium">Movimiento</th>
                            <th scope="col" className="px-2 py-3 text-right font-medium">Cantidad</th>
                            <th scope="col" className="px-2 py-3 text-right font-medium">Valor</th>
                            <th scope="col" className="px-2 py-3 text-right font-medium">Queda</th>
                            <th scope="col" className="px-4 py-3 font-medium">Quién y por qué</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y">
                          {filas.map((m) => {
                            const ing = porId.get(m.ingredientId)
                            const unidad = ing?.unit ?? "u"
                            return (
                              <tr key={m.id}>
                                <td className="cifra px-4 py-2.5 whitespace-nowrap text-muted-foreground">{formatoHora(m.at, timezone)}</td>
                                <td className="px-2 py-2.5 font-medium">{ing?.name ?? "Ingrediente borrado"}</td>
                                <td className="px-2 py-2.5"><Tag tone={m.kind === "waste" || m.kind === "count_adjust" || m.kind === "adjustment" ? "aviso" : "neutro"}>{MOVEMENT_KIND_LABEL[m.kind]}</Tag></td>
                                <td className={`cifra px-2 py-2.5 text-right ${m.quantity < 0 ? "text-destructive" : "text-success"}`}>
                                  {m.quantity > 0 ? "+" : ""}{textoCantidad(m.quantity, unidad)}
                                </td>
                                <td className="cifra px-2 py-2.5 text-right text-muted-foreground">{m.valueCents === 0 ? "—" : euros(m.valueCents)}</td>
                                <td className="cifra px-2 py-2.5 text-right">{textoCantidad(m.quantityAfter, unidad)}</td>
                                <td className="px-4 py-2.5 text-muted-foreground">
                                  {m.by ? (nombres.get(m.by) ?? "Alguien del equipo") : "Sistema"}
                                  {m.wasteReason ? ` · ${WASTE_REASON_LABEL[m.wasteReason]}` : ""}
                                  {m.reason ? ` · ${m.reason}` : ""}
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                    {todos.length >= max ? (
                      <div className="flex justify-center">
                        <Button variant="outline" size="lg" onClick={() => setMax(max + 100)}>Ver más antiguos</Button>
                      </div>
                    ) : null}
                  </>
                )
              }}
            </Cargado>
          </div>
        )
      }}
    </Cargado>
  )
}
