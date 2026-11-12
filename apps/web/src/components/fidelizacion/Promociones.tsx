"use client"

import { useState } from "react"
import { type Promotion, type PromotionInput, horaLocal, instanteDeHoraLocal } from "@llenamos/core"
import { PlusIcon, SealPercentIcon } from "@phosphor-icons/react"
import { useAccesoFidelizacion } from "./Marco"
import { Bloque, Datos, Resultado } from "./piezas"
import { esquemas, useColeccion } from "@/lib/fidelizacion/datos"
import { useOperacion } from "@/lib/fidelizacion/hooks"
import { type Acceso, type ApiFidelizacion, permitido, llamarFidelizacion } from "@/lib/fidelizacion/api"
import { useCatalogoFidelizacion, type Catalogo } from "@/lib/fidelizacion/catalogo"
import { centimos, DIAS, ESTADOS, euros, nuevaPromocion, textoImporte } from "@/lib/fidelizacion/presentacion"
import { Notice } from "@/components/common/notice"
import { TextField, TextareaField, SelectField } from "@/components/common/form-fields"
import { DateInput } from "@/components/common/date-picker"
import { TimeSelectField } from "@/components/common/time-select-field"
import { Tag } from "@/components/common/tag"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"

type Promo = Promotion & { id: string }
export function Promociones() {
  const acceso = useAccesoFidelizacion()
  const promociones = useColeccion(acceso.restaurant.id, "promotions", esquemas.PromotionSchema, permitido(acceso, "guardarPromocion"))
  const carta = useCatalogoFidelizacion(acceso.restaurant.id, acceso.location?.id ?? null)
  const catalogo: Catalogo = { locations: acceso.locations.map((l) => ({ id: l.id, name: l.name })), items: carta.items.status === "ready" ? carta.items.data.map((i) => ({ id: i.id, name: i.name.es })) : [], categories: carta.categories.status === "ready" ? carta.categories.data.map((c) => ({ id: c.id, name: c.name.es })) : [] }
  return <Datos live={promociones}>{(lista) => <PromocionesVista key={acceso.restaurant.id} restaurantId={acceso.restaurant.id} acceso={acceso} promociones={lista} catalogo={catalogo} timezone={acceso.restaurant.timezone} />}</Datos>
}
export function PromocionesVista({ restaurantId, acceso, promociones, catalogo, timezone = "Europe/Madrid", api = llamarFidelizacion }: { restaurantId: string; acceso: Acceso; promociones: Promo[]; catalogo: Catalogo; timezone?: string; api?: ApiFidelizacion }) {
  const [filtro, filtrar] = useState("todas")
  const [editor, editar] = useState<Promo | "nueva" | null>(null)
  const [mensaje, mostrar] = useState<string | null>(null)
  const [confirmar, confirmarArchivo] = useState<Promo | null>(null)
  const op = useOperacion(api)
  if (!permitido(acceso, "guardarPromocion")) return <Notice>Tu rol no puede configurar promociones.</Notice>
  async function estado(p: Promo, to: "active" | "paused" | "archived") {
    const r = await op.ejecutar("cambiarEstadoPromocion", { restaurantId, promotionId: p.id, expectedRevision: p.revision, to })
    if (r) { mostrar(`Estado confirmado: ${ESTADOS[r.status]}.`); confirmarArchivo(null) }
  }
  return <div className="space-y-5">
    <Resultado error={op.mensaje} mensaje={mensaje} />
    <Bloque titulo="Un motivo para volver" extra={<Button onClick={() => editar("nueva")}><PlusIcon aria-hidden />Nueva promoción</Button>}>
      <div className="max-w-xs"><SelectField label="Ver promociones" value={filtro} onChange={(e) => filtrar(e.target.value)}><option value="todas">Todas</option>{Object.entries(ESTADOS).map(([id, texto]) => <option key={id} value={id}>{texto}</option>)}</SelectField></div>
      <ul className="divide-y">{promociones.filter((p) => filtro === "todas" || p.status === filtro).map((p) => <li key={p.id} className="py-4"><div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><SealPercentIcon aria-hidden className="text-warning" /><h3 className="font-medium">{p.name}</h3><Tag tone={p.status === "active" ? "habitual" : "neutro"}>{ESTADOS[p.status]}</Tag></div><p className="mt-2 text-sm text-soft-foreground">{p.discount.kind === "percent" ? `${p.discount.bp / 100} %` : euros(p.discount.cents)} · {p.scope.kind === "bill" ? "Toda la cuenta" : p.scope.kind === "items" ? "Platos elegidos" : "Categorías elegidas"} · {p.stacking === "with_loyalty" ? "Compatible con puntos" : "Sin combinar con puntos"}</p><p className="mt-1 text-xs text-muted-foreground">{p.weekdays.length ? p.weekdays.map((d) => DIAS[d - 1]).join(", ") : "Todos los días"}{p.timeWindows.length ? ` · ${p.timeWindows.map((w) => `${w.from} a ${w.to}${w.to < w.from ? " del día siguiente" : ""}`).join(", ")}` : " · Todo el día"}</p><p className="mt-1 text-xs text-muted-foreground">{p.uses}{p.usageLimit ? ` de ${p.usageLimit}` : ""} usos · {p.code ? `Código ${p.code}` : "Sin código"}{p.perCustomerLimit ? ` · ${p.perCustomerLimit} por cliente` : ""}</p></div><div className="flex flex-wrap gap-1"><Button variant="ghost" disabled={p.status === "archived"} aria-label={`Editar ${p.name}`} onClick={() => editar(p)}>Editar</Button>{p.status !== "archived" ? <><Button variant="outline" disabled={op.busy} onClick={() => estado(p, p.status === "active" ? "paused" : "active")}>{p.status === "active" ? "Pausar" : "Activar"}</Button><Button variant="ghost" disabled={op.busy} onClick={() => confirmarArchivo(p)}>Archivar</Button></> : null}</div></div></li>)}</ul>
      {!promociones.some((p) => filtro === "todas" || p.status === filtro) ? <p className="py-4 text-sm text-muted-foreground">No hay promociones en esta vista.</p> : null}
    </Bloque>
    {confirmar ? <Bloque titulo={`Archivar ${confirmar.name}`}><p className="text-sm">Dejará de ofrecerse en caja. Se conserva el historial de usos y las cuentas ya cobradas.</p><div className="flex gap-2"><Button variant="outline" disabled={op.busy} onClick={() => estado(confirmar, "archived")}>Confirmar archivo</Button><Button variant="ghost" onClick={() => confirmarArchivo(null)}>Volver</Button></div></Bloque> : null}
    {editor ? <EditorPromocion key={editor === "nueva" ? editor : `${editor.id}:${editor.revision}`} restaurantId={restaurantId} promocion={editor === "nueva" ? null : editor} catalogo={catalogo} timezone={timezone} api={api} cerrar={() => editar(null)} /> : null}
  </div>
}
function ListaCasillas({ titulo, opciones, value, cambiar }: { titulo: string; opciones: { id: string; name: string }[]; value: string[]; cambiar: (v: string[]) => void }) {
  return <fieldset className="space-y-2"><legend className="mb-2 text-sm font-medium">{titulo}</legend><div className="flex flex-wrap gap-x-5 gap-y-2">{opciones.map((o) => <label key={o.id} className="flex min-h-11 items-center gap-2 text-sm"><Checkbox checked={value.includes(o.id)} onCheckedChange={(v) => cambiar(v ? [...value, o.id] : value.filter((id) => id !== o.id))} />{o.name}</label>)}</div></fieldset>
}
function EditorPromocion({ restaurantId, promocion, catalogo, timezone, api, cerrar }: { restaurantId: string; promocion: Promo | null; catalogo: Catalogo; timezone: string; api: ApiFidelizacion; cerrar: () => void }) {
  const inicial = promocion ?? nuevaPromocion()
  const [p, modificar] = useState<PromotionInput>(() => { return Object.fromEntries(Object.entries(inicial).filter(([key]) => !["status", "uses", "revision", "id"].includes(key))) as PromotionInput })
  const [descuento, setDescuento] = useState(textoImporte(inicial.discount.kind === "amount" ? inicial.discount.cents : inicial.discount.bp))
  const [minimo, setMinimo] = useState(textoImporte(inicial.minSpendCents))
  const [tope, setTope] = useState(inicial.maxDiscountCents === null ? "" : textoImporte(inicial.maxDiscountCents))
  const [error, fallo] = useState<string | null>(null)
  const [mensaje, mostrar] = useState<string | null>(null)
  const op = useOperacion(api)
  const set = <K extends keyof PromotionInput>(k: K, value: PromotionInput[K]) => modificar((a) => ({ ...a, [k]: value }))
  const instante = (ms: number | null) => ms === null ? "" : horaLocal(ms, timezone).fecha
  function guardarFecha(campo: "validFrom" | "validTo", fecha: string) {
    if (!fecha) { set(campo, null); return }
    const ms = instanteDeHoraLocal(fecha, campo === "validFrom" ? 0 : 1439, timezone)
    if (ms === null) { fallo("La fecha no existe en la zona del restaurante."); return }
    set(campo, campo === "validTo" ? ms + 60000 : ms)
  }
  return <Bloque titulo={promocion ? `Editar ${promocion.name}` : "Preparar una promoción"} extra={<Button variant="ghost" onClick={cerrar}>Cerrar editor</Button>}><form className="space-y-6" onSubmit={async (e) => {
    e.preventDefault(); fallo(null); mostrar(null)
    try { const r = await op.ejecutar("guardarPromocion", { restaurantId, promotionId: promocion?.id ?? null, expectedRevision: promocion?.revision ?? null, promotion: { ...p, discount: p.discount.kind === "percent" ? { kind: "percent", bp: centimos(descuento) } : { kind: "amount", cents: centimos(descuento) }, minSpendCents: centimos(minimo), maxDiscountCents: tope === "" ? null : centimos(tope) } }); if (r) mostrar(`Promoción guardada: ${ESTADOS[r.status]}. Cierra el editor para ver la versión actualizada.`) } catch (e) { fallo(e instanceof Error ? e.message : "Revisa la promoción.") }
  }}>
    <div className="grid gap-4 sm:grid-cols-2"><TextField label="Nombre de la promoción" required maxLength={80} value={p.name} onChange={(e) => set("name", e.target.value)} /><TextField label="Código opcional" maxLength={20} hint="De 3 a 20 letras o cifras. Vacío si no necesita código." value={p.code ?? ""} onChange={(e) => set("code", e.target.value.toUpperCase() || null)} /><TextareaField label="Descripción" maxLength={300} value={p.description} onChange={(e) => set("description", e.target.value)} /><SelectField label="Compatibilidad" value={p.stacking} onChange={(e) => set("stacking", e.target.value as PromotionInput["stacking"])}><option value="exclusive">No combinar con canjes de puntos</option><option value="with_loyalty">Permitir canjes de puntos</option></SelectField><SelectField label="Tipo de descuento" value={p.discount.kind} onChange={(e) => set("discount", e.target.value === "percent" ? { kind: "percent", bp: 1000 } : { kind: "amount", cents: 500 })}><option value="percent">Porcentaje</option><option value="amount">Importe fijo</option></SelectField><TextField label={p.discount.kind === "percent" ? "Porcentaje de descuento" : "Descuento en euros"} value={descuento} inputMode="decimal" required onChange={(e) => setDescuento(e.target.value)} /><TextField label="Gasto mínimo en euros" value={minimo} inputMode="decimal" required onChange={(e) => setMinimo(e.target.value)} /><TextField label="Tope de descuento en euros" hint="Vacío si no hay tope." value={tope} inputMode="decimal" onChange={(e) => setTope(e.target.value)} /><TextField label="Cupo total" type="number" min={1} step={1} hint="Vacío si no hay límite." value={p.usageLimit ?? ""} onChange={(e) => set("usageLimit", e.target.value ? Number(e.target.value) : null)} /><TextField label="Usos por cliente" type="number" min={1} max={1000} step={1} hint="Si hay límite, la cuenta debe tener cliente." value={p.perCustomerLimit ?? ""} onChange={(e) => set("perCustomerLimit", e.target.value ? Number(e.target.value) : null)} /><TextField label="Prioridad en caso de empate" type="number" min={0} max={100} step={1} value={p.priority} onChange={(e) => set("priority", Number(e.target.value))} /><SelectField label="Dónde se descuenta" value={p.scope.kind} onChange={(e) => set("scope", e.target.value === "bill" ? { kind: "bill" } : e.target.value === "items" ? { kind: "items", itemIds: [] } : { kind: "categories", categoryIds: [] })}><option value="bill">Toda la cuenta</option><option value="items">Platos elegidos</option><option value="categories">Categorías elegidas</option></SelectField></div>
    {p.scope.kind !== "bill" ? <><ListaCasillas titulo={p.scope.kind === "items" ? "Platos del local elegido" : "Categorías del local elegido"} opciones={p.scope.kind === "items" ? catalogo.items : catalogo.categories} value={p.scope.kind === "items" ? p.scope.itemIds : p.scope.categoryIds} cambiar={(v) => set("scope", p.scope.kind === "items" ? { kind: "items", itemIds: v } : { kind: "categories", categoryIds: v })} /><p className="text-xs text-muted-foreground">La carta corresponde al local seleccionado en el panel. Cambia de local para elegir su carta.</p></> : null}
    <ListaCasillas titulo="Locales, todos si no eliges ninguno" opciones={catalogo.locations} value={p.locationIds} cambiar={(v) => set("locationIds", v)} />
    <ListaCasillas titulo="Tipos de pedido" opciones={[{ id: "dine_in", name: "En mesa" }, { id: "takeaway", name: "Para llevar" }, { id: "qr", name: "Pedido por QR" }]} value={p.channels} cambiar={(v) => set("channels", v as PromotionInput["channels"])} />
    <div className="grid gap-4 sm:grid-cols-2"><div className="space-y-2"><p className="text-sm font-medium">Desde el día</p><DateInput label="Primer día de la promoción" value={instante(p.validFrom)} onChange={(v) => guardarFecha("validFrom", v)} /></div><div className="space-y-2"><p className="text-sm font-medium">Hasta el día incluido</p><DateInput label="Último día de la promoción" value={p.validTo === null ? "" : horaLocal(p.validTo - 1, timezone).fecha} onChange={(v) => guardarFecha("validTo", v)} /></div></div>
    <ListaCasillas titulo="Días de la semana, todos si no eliges ninguno" opciones={DIAS.map((name, i) => ({ id: String(i + 1), name }))} value={p.weekdays.map(String)} cambiar={(v) => set("weekdays", v.map(Number))} />
    <div className="space-y-4"><h3 className="text-sm font-medium">Franjas horarias</h3><p className="text-xs text-muted-foreground">Sin franjas vale todo el día. Una franja de 22:00 a 02:00 pertenece al día en que empieza, también después de medianoche. Zona del restaurante: {timezone}.</p>{p.timeWindows.map((w, i) => <div key={i} className="grid items-end gap-3 sm:grid-cols-[1fr_1fr_auto]"><TimeSelectField label={`Desde, franja ${i + 1}`} value={w.from} onChange={(v) => set("timeWindows", p.timeWindows.map((a, j) => j === i ? { ...a, from: v } : a))} /><TimeSelectField label={`Hasta, franja ${i + 1}`} value={w.to} onChange={(v) => set("timeWindows", p.timeWindows.map((a, j) => j === i ? { ...a, to: v } : a))} /><Button type="button" variant="ghost" onClick={() => set("timeWindows", p.timeWindows.filter((_, j) => j !== i))}>Quitar franja {i + 1}</Button></div>)}<Button type="button" variant="outline" disabled={p.timeWindows.length >= 4} onClick={() => set("timeWindows", [...p.timeWindows, { from: "22:00", to: "02:00" }])}><PlusIcon aria-hidden />Añadir franja</Button></div>
    <Resultado error={error ?? op.mensaje} mensaje={mensaje} /><Button type="submit" variant="outline" disabled={op.busy || !!mensaje}>Guardar promoción</Button>
  </form></Bloque>
}
