"use client"

import { useState, type FormEvent } from "react"
import { defaultLoyaltySettings, type LoyaltySettings, type LoyaltyReward, type LoyaltyRewardInputSchema } from "@llenamos/core"
import type { z } from "zod"
import { PlusIcon, GiftIcon } from "@phosphor-icons/react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { TextField, SelectField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { useOperacion } from "@/lib/fidelizacion/hooks"
import { esquemas, useColeccion, useDocumento } from "@/lib/fidelizacion/datos"
import { llamarFidelizacion, permitido, type Acceso, type ApiFidelizacion } from "@/lib/fidelizacion/api"
import { centimos, euros, textoImporte } from "@/lib/fidelizacion/presentacion"
import { Bloque, Datos, Resultado } from "./piezas"
import { useCatalogoFidelizacion, type Catalogo } from "@/lib/fidelizacion/catalogo"
import { useAccesoFidelizacion } from "./Marco"

type Premio = LoyaltyReward & { id: string }
export function Programa() {
  const acceso = useAccesoFidelizacion()
  const ajustes = useDocumento(acceso.restaurant.id, "settings/loyalty", esquemas.LoyaltySettingsSchema, permitido(acceso, "guardarConfiguracionFidelizacion"))
  const premios = useColeccion(acceso.restaurant.id, "loyaltyRewards", esquemas.LoyaltyRewardSchema, permitido(acceso, "guardarPremio"))
  const catalogo = useCatalogoFidelizacion(acceso.restaurant.id, acceso.location?.id ?? null)
  return <Datos live={ajustes}>{(settings) => <Datos live={premios}>{(rewards) => <ProgramaVista catalogo={{ items: catalogo.items.status === "ready" ? catalogo.items.data.map((i) => ({ id: i.id, name: i.name.es })) : [], categories: [], locations: [] }} key={acceso.restaurant.id} restaurantId={acceso.restaurant.id} acceso={acceso} settings={settings} rewards={rewards} />}</Datos>}</Datos>
}
export function ProgramaVista({ restaurantId, acceso, settings, rewards, catalogo, api = llamarFidelizacion }: { restaurantId: string; acceso: Acceso; settings: LoyaltySettings | null; rewards: Premio[]; catalogo: Catalogo; api?: ApiFidelizacion }) {
  const [editor, editar] = useState<Premio | "nuevo" | null>(null)
  if (!permitido(acceso, "guardarConfiguracionFidelizacion")) return <Notice>Tu rol no puede configurar el programa ni los premios.</Notice>
  const programa = settings ?? defaultLoyaltySettings()
  return <div className="space-y-5">
    <SummaryStrip label="Resumen del programa" items={[{ label: "Puntos por euro", value: programa.pointsPerEuro, hint: programa.enabled ? "Acumulación activa" : "Acumulación apagada" }, { label: "Premios activos", value: rewards.filter((r) => r.active).length }, { label: "Validez de los puntos", value: programa.expiryDays ?? "Siempre", hint: programa.expiryDays ? "días desde que se ganan" : "No caducan" }]} />
    {!settings ? <Notice title="Programa sin configurar">No hay ajustes guardados. El programa empieza apagado.</Notice> : null}
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <AjustesPrograma key={JSON.stringify(programa)} restaurantId={restaurantId} settings={programa} api={api} />
      <Bloque titulo="Premios para volver" extra={<Button variant="outline" onClick={() => editar("nuevo")}><PlusIcon aria-hidden />Nuevo premio</Button>}>
        {rewards.length ? <ul className="divide-y">{rewards.map((r) => <li key={r.id} className="flex items-start justify-between gap-3 py-4"><div className="min-w-0"><p className="flex items-center gap-2 text-sm font-medium"><GiftIcon aria-hidden className="shrink-0 text-warning" />{r.name}</p><p className="mt-1 text-xs text-muted-foreground"><span className="cifra">{r.pointsCost} puntos</span> · {r.kind === "item" ? "Plato con tope de " : "Descuento de "}{euros(r.valueCents)} · {r.active ? "Activo" : "Apagado"}</p></div><Button variant="ghost" aria-label={`Editar ${r.name}`} onClick={() => editar(r)}>Editar</Button></li>)}</ul> : <p className="text-sm text-muted-foreground">Crea el primer premio del programa.</p>}
        <p className="text-xs text-muted-foreground">Los premios se canjean sobre una cuenta abierta. El precio y los puntos disponibles los valida el servidor.</p>
      </Bloque>
    </div>
    {editor ? <PremioEditor key={typeof editor === "string" ? editor : editor.id} restaurantId={restaurantId} premio={editor === "nuevo" ? null : editor} catalogo={catalogo} api={api} cerrar={() => editar(null)} /> : null}
  </div>
}
function AjustesPrograma({ restaurantId, settings, api }: { restaurantId: string; settings: LoyaltySettings; api: ApiFidelizacion }) {
  const [enabled, encender] = useState(settings.enabled)
  const [points, puntos] = useState(String(settings.pointsPerEuro))
  const [minimum, minimo] = useState(textoImporte(settings.minSpendCents))
  const [expiry, caducidad] = useState(settings.expiryDays === null ? "" : String(settings.expiryDays))
  const [version, condiciones] = useState(settings.termsVersion)
  const [mensaje, mostrar] = useState<string | null>(null)
  const [error, fallo] = useState<string | null>(null)
  const op = useOperacion(api)
  async function guardar(e: FormEvent) {
    e.preventDefault(); fallo(null); mostrar(null)
    try {
      const r = await op.ejecutar("guardarConfiguracionFidelizacion", { restaurantId, settings: { enabled, pointsPerEuro: Number(points), minSpendCents: centimos(minimum), expiryDays: expiry === "" ? null : Number(expiry), termsVersion: version } })
      if (r) mostrar("Configuración guardada por el servidor.")
    } catch (e) { fallo(e instanceof Error ? e.message : "Revisa los campos.") }
  }
  return <Bloque titulo="Cómo se ganan los puntos"><form onSubmit={guardar} className="space-y-4">
    <label className="flex min-h-11 items-center justify-between gap-3 text-sm">Acumular puntos<Switch checked={enabled} onCheckedChange={encender} /></label>
    <div className="grid gap-4 sm:grid-cols-2"><TextField label="Puntos por euro" type="number" min={0} max={100} step={1} value={points} required onChange={(e) => puntos(e.target.value)} /><TextField label="Gasto mínimo en euros" inputMode="decimal" value={minimum} required onChange={(e) => minimo(e.target.value)} /><TextField label="Caducidad en días" type="number" min={30} max={1825} step={1} hint="Vacío si no caducan." value={expiry} onChange={(e) => caducidad(e.target.value)} /><TextField label="Versión de las condiciones" required maxLength={40} value={version} onChange={(e) => condiciones(e.target.value)} /></div>
    <p className="text-xs text-muted-foreground">Se acumulan al cobrar, sobre el importe final sin propina. Las devoluciones descuentan los puntos en proporción. Apagar el programa conserva el historial y los saldos.</p>
    <Resultado error={error ?? op.mensaje} mensaje={mensaje} />
    <Button disabled={op.busy} type="submit">Guardar programa</Button>
  </form></Bloque>
}
function PremioEditor({ restaurantId, premio, catalogo, api, cerrar }: { restaurantId: string; premio: Premio | null; catalogo: Catalogo; api: ApiFidelizacion; cerrar: () => void }) {
  const [name, nombre] = useState(premio?.name ?? "")
  const [points, puntos] = useState(String(premio?.pointsCost ?? 50))
  const [kind, tipo] = useState<"amount" | "item">(premio?.kind ?? "amount")
  const [value, valor] = useState(textoImporte(premio?.valueCents ?? 500))
  const [item, plato] = useState(premio?.itemId ?? "")
  const [active, activar] = useState(premio?.active ?? true)
  const [error, fallo] = useState<string | null>(null)
  const [mensaje, mostrar] = useState<string | null>(null)
  const op = useOperacion(api)
  return <Bloque titulo={premio ? "Editar premio" : "Nuevo premio"} extra={<Button variant="ghost" onClick={cerrar}>Cerrar editor</Button>}><form className="space-y-4" onSubmit={async (e) => {
    e.preventDefault(); fallo(null); mostrar(null)
    try { const reward: z.input<typeof LoyaltyRewardInputSchema> = { name, pointsCost: Number(points), kind, valueCents: centimos(value), itemId: kind === "item" ? item : null, active }; const r = await op.ejecutar("guardarPremio", { restaurantId, rewardId: premio?.id ?? null, expectedRevision: premio?.revision ?? null, reward }); if (r) mostrar("Premio guardado. Cierra el editor para ver la versión actualizada.") } catch (e) { fallo(e instanceof Error ? e.message : "Revisa el premio.") }
  }}>
    <div className="grid gap-4 sm:grid-cols-2"><TextField label="Nombre del premio" required maxLength={80} value={name} onChange={(e) => nombre(e.target.value)} /><TextField label="Puntos necesarios" type="number" min={1} step={1} required value={points} onChange={(e) => puntos(e.target.value)} /><SelectField label="Tipo de premio" value={kind} onChange={(e) => tipo(e.target.value as "amount" | "item")}><option value="amount">Descuento en la cuenta</option><option value="item">Un plato de la carta</option></SelectField><TextField label={kind === "item" ? "Tope del plato en euros" : "Descuento en euros"} inputMode="decimal" required value={value} onChange={(e) => valor(e.target.value)} />{kind === "item" ? <SelectField label="Plato del premio" hint="Platos del local elegido. El servidor valida su precio al canjear." required value={item} onChange={(e) => plato(e.target.value)}><option value="">Elige un plato</option>{item && !catalogo.items.some((i) => i.id === item) ? <option value={item}>Plato de otro local o ya retirado</option> : null}{catalogo.items.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}</SelectField> : null}</div>
    <label className="flex min-h-11 items-center gap-3 text-sm"><Switch checked={active} onCheckedChange={activar} />Premio activo</label><Resultado error={error ?? op.mensaje} mensaje={mensaje} /><Button variant="outline" disabled={op.busy || !!mensaje}>Guardar premio</Button>
  </form></Bloque>
}
