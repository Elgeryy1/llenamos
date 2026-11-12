"use client"
import { useRef, useState } from "react"
import { defaultFloorSettings, hasModule, type FloorSettings, type Station } from "@llenamos/core"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Button } from "@/components/ui/button"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { RequireModule } from "@/components/panel/RequireModule"
import { usePanel } from "@/components/panel/PanelContext"
import { errorText, saveCarta } from "@/lib/carta/callables"
import { useFloor, useStations } from "@/lib/carta/hooks"
import { QrPanel } from "./QrPanel"
import { ErrorNotice } from "./ErrorNotice"
import { NumberField, Toggle } from "./Fields"
export function FloorPanel() {
  return (
    <RequirePermission permission="sala.configurar" what="los ajustes de sala">
      <RequireModule module="floor">
        <Floor />
      </RequireModule>
    </RequirePermission>
  )
}
function Floor() {
  const { restaurant, location } = usePanel()
  const scope = { restaurantId: restaurant.id, locationId: location?.id ?? "" }
  const base = location ? `restaurants/${restaurant.id}/locations/${location.id}` : null
  const doc = useFloor(base),
    stations = useStations(hasModule(restaurant, "kitchen") ? base : null)
  const [draft, setDraft] = useState<FloorSettings | null>(null)
  const settings = draft ?? (doc.status === "ready" ? doc.data.settings : defaultFloorSettings())
  const [station, setStation] = useState<(Station & { id: string | null }) | null>(null)
  const [pending, setPending] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState("")
  const lock = useRef(false)
  const list = stations.status === "ready" ? stations.data : []
  const set = <K extends keyof FloorSettings>(k: K, value: FloorSettings[K]) => setDraft({ ...settings, [k]: value })
  async function run(action: () => Promise<void>) {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError("")
    setMessage("")
    try {
      await action()
    } catch (e) {
      setError(errorText(e))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  if (!location) return <p>Elige un local para configurar su servicio.</p>
  return (
    <>
      <PageHeading
        title="El servicio, a tu manera"
        eyebrow={location.name}
        description="Configura el pedido desde mesa, los pases y las recogidas. Pedir la cuenta avisa al personal; no registra ningún pago."
      />
      <SummaryStrip
        label="Configuración actual"
        items={[
          { label: "Pedido en mesa", value: settings.selfOrder.enabled ? "Sí" : "No" },
          { label: "Aprobación", value: settings.selfOrder.requireApproval ? "Sí" : "No" },
          { label: "Para llevar", value: settings.takeaway.enabled ? "Sí" : "No" },
        ]}
      />
      {doc.status === "error" && <ErrorNotice message={errorText(doc.error)} />}
      {doc.status !== "ready" || !doc.data.saved ? (
        <p className="my-4 text-sm text-warning">
          Valores iniciales sin confirmar. Se aplicarán cuando el servidor confirme que se han guardado.
        </p>
      ) : null}
      {error && <ErrorNotice message={error} />}
      {message && (
        <p role="status" className="my-4 text-success">
          {message}
        </p>
      )}
      <form
        className="superficie my-6 space-y-6 p-5 sm:p-6"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await saveCarta("guardarConfiguracionSala", { ...scope, settings })
            setDraft(null)
            setMessage("Configuración guardada por el servidor.")
          })
        }}
      >
        <fieldset disabled={pending} className="space-y-6">
          <section>
            <h2 className="mb-3 text-lg font-semibold">Desde la mesa</h2>
            {(
              [
                ["enabled", "Permitir pedir desde el QR"],
                ["requireApproval", "El camarero confirma cada pedido"],
                ["callWaiter", "Permitir llamar al camarero"],
                ["requestBill", "Permitir pedir la cuenta"],
              ] as const
            ).map(([k, label]) => (
              <Toggle
                key={k}
                label={label}
                checked={settings.selfOrder[k]}
                onChange={(v) => set("selfOrder", { ...settings.selfOrder, [k]: v })}
              />
            ))}
          </section>
          <section className="space-y-4 border-t pt-5">
            <h2 className="text-lg font-semibold">Pases y tiempos</h2>
            <SelectField
              label="Cómo marchan los platos"
              value={settings.firing.mode}
              onChange={(e) =>
                set("firing", { ...settings.firing, mode: e.target.value as FloorSettings["firing"]["mode"] })
              }
            >
              <option value="by_course">Por pases</option>
              <option value="all_at_once">Todo al momento</option>
            </SelectField>
            <Toggle
              label="Marchar el siguiente pase al servir el anterior"
              checked={settings.firing.autoFireNextCourse}
              onChange={(v) => set("firing", { ...settings.firing, autoFireNextCourse: v })}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              {(Object.keys(settings.targets) as (keyof FloorSettings["targets"])[]).map((k) => (
                <NumberField
                  key={k}
                  label={
                    {
                      defaultPrepMinutes: "Preparación (min)",
                      pickupMinutes: "Recoger del pase (min)",
                      callWaiterMinutes: "Llamada (min)",
                      billMinutes: "Cuenta (min)",
                      approveMinutes: "Aprobación (min)",
                      customMinutes: "Otras tareas (min)",
                    }[k]
                  }
                  value={settings.targets[k]}
                  min={1}
                  max={k === "defaultPrepMinutes" || k === "customMinutes" ? 240 : 60}
                  onChange={(v) => set("targets", { ...settings.targets, [k]: v })}
                />
              ))}
            </div>
            <SelectField
              label="Estación por defecto"
              disabled={!hasModule(restaurant, "kitchen")}
              value={settings.defaultStationId ?? "none"}
              onChange={(e) => set("defaultStationId", e.target.value === "none" ? null : e.target.value)}
            >
              <option value="none">Sin estación, lo sirve la sala</option>
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </SelectField>
          </section>
          <section className="space-y-3 border-t pt-5">
            <h2 className="text-lg font-semibold">Para llevar</h2>
            <p className="text-sm text-muted-foreground">
              Las horas disponibles usan los horarios del local. La recogida no confirma un pago.
            </p>
            {(
              [
                ["enabled", "Activar para llevar"],
                ["publicOrdering", "Permitir pedir desde la web"],
                ["autoAccept", "Aceptar los pedidos públicos automáticamente"],
              ] as const
            ).map(([k, label]) => (
              <Toggle
                key={k}
                label={label}
                checked={settings.takeaway[k]}
                onChange={(v) => set("takeaway", { ...settings.takeaway, [k]: v })}
              />
            ))}
            <div className="grid gap-4 sm:grid-cols-3">
              <SelectField
                label="Intervalo de recogida"
                value={settings.takeaway.stepMinutes}
                onChange={(e) =>
                  set("takeaway", {
                    ...settings.takeaway,
                    stepMinutes: Number(e.target.value) as FloorSettings["takeaway"]["stepMinutes"],
                  })
                }
              >
                {[5, 10, 15, 20, 30].map((n) => (
                  <option key={n} value={n}>
                    {n} min
                  </option>
                ))}
              </SelectField>
              {(
                [
                  ["minNoticeMinutes", "Antelación mínima (min)", 1440],
                  ["maxOrdersPerSlot", "Pedidos por franja", 100],
                  ["prepLeadMinutes", "Empezar antes de recoger (min)", 240],
                ] as const
              ).map(([k, label, max]) => (
                <NumberField
                  key={k}
                  label={label}
                  max={max}
                  min={k === "maxOrdersPerSlot" ? 1 : 0}
                  value={settings.takeaway[k]}
                  onChange={(v) => set("takeaway", { ...settings.takeaway, [k]: v })}
                />
              ))}
            </div>
          </section>
        </fieldset>
        <Button disabled={pending} type="submit">
          {pending ? "Guardando…" : "Guardar configuración"}
        </Button>
      </form>
      {hasModule(restaurant, "kitchen") && (
        <section className="superficie my-6 space-y-4 p-5">
          <h2 className="text-lg font-semibold">Estaciones de cocina y barra</h2>
          {stations.status === "error" && <ErrorNotice message={errorText(stations.error)} />}
          <div className="divide-y">
            {list.map((s) => (
              <div key={s.id} className="flex justify-between gap-4 py-3">
                <p>
                  {s.name} · {s.kind === "bar" ? "barra" : "cocina"} · {s.active ? "Activa" : "Inactiva"}
                </p>
                <Button variant="outline" onClick={() => setStation(s)}>
                  Editar
                </Button>
              </div>
            ))}
          </div>
          <Button
            variant="outline"
            onClick={() =>
              setStation({
                id: null,
                name: "",
                kind: "kitchen",
                sortOrder: 0,
                targetMinutes: 15,
                pickup: true,
                active: true,
              })
            }
          >
            Nueva estación
          </Button>
          {station && (
            <form
              className="space-y-4 border-t pt-4"
              onSubmit={(e) => {
                e.preventDefault()
                void run(async () => {
                  const { id, ...s } = station
                  await saveCarta("guardarEstacion", { ...scope, stationId: id, station: s })
                  setStation(null)
                  setMessage("Estación guardada.")
                })
              }}
            >
              <TextField
                label="Nombre de la estación"
                value={station.name}
                onChange={(e) => setStation({ ...station, name: e.target.value })}
              />
              <SelectField
                label="Tipo de estación"
                value={station.kind}
                onChange={(e) => setStation({ ...station, kind: e.target.value as Station["kind"] })}
              >
                <option value="kitchen">Cocina</option>
                <option value="bar">Barra</option>
              </SelectField>
              <NumberField
                label="Preparación objetivo (min)"
                min={1}
                value={station.targetMinutes}
                onChange={(targetMinutes) => setStation({ ...station, targetMinutes })}
              />
              <NumberField
                label="Posición"
                value={station.sortOrder}
                onChange={(sortOrder) => setStation({ ...station, sortOrder })}
              />
              <Toggle
                label="Sala recoge los platos del pase"
                checked={station.pickup}
                onChange={(pickup) => setStation({ ...station, pickup })}
              />
              <Toggle
                label="Estación activa"
                checked={station.active}
                onChange={(active) => setStation({ ...station, active })}
              />
              <Button disabled={pending} variant="outline" type="submit">
                Guardar estación
              </Button>
              <Button variant="ghost" type="button" onClick={() => setStation(null)}>
                Cerrar
              </Button>
            </form>
          )}
        </section>
      )}
      <QrPanel />
    </>
  )
}
