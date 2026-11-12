"use client"

import {
  TAKEAWAY_STATUS_LABEL,
  TAKEAWAY_TRANSITIONS,
  pickupSlots,
  type Takeaway,
} from "@llenamos/core"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { Desplegable } from "@/components/common/desplegable"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { llamarSala } from "@/lib/comandero/callables"
import {
  useAjustesSala,
  useCarta,
  useRecogidas,
  type Alcance,
} from "@/lib/comandero/datos"
import { euros, problemasPedido } from "@/lib/comandero/modelo"
import { useReservationSettings } from "@/lib/data/reservas"
import { localDate } from "@/lib/reservas/dia"
import { timeOf } from "@/lib/reservas/formato"
import { useNow } from "@/lib/reservas/hooks"
import { HistorialPedido } from "./HistorialPedido"
import { Pedido } from "./Pedido"
import { EnlacesServicio, EstadoLectura, useOperacion } from "./Servicio"

export function ParaLlevar() {
  const { restaurant, location } = usePanel()
  return (
    <RequirePermission
      permission="comandas.tomar"
      what="los pedidos para llevar"
    >
      <RequireModule module="floor">
        {location ? (
          <RecogidasLocal
            key={`${restaurant.id}/${location.id}`}
            scope={{ restaurantId: restaurant.id, locationId: location.id }}
          />
        ) : (
          <Notice>Elige un local para gestionar las recogidas.</Notice>
        )}
      </RequireModule>
    </RequirePermission>
  )
}

function RecogidasLocal({ scope }: { scope: Alcance }) {
  const { restaurant, location } = usePanel()
  const params = useSearchParams()
  const router = useRouter()
  const now = useNow()
  const [selected, setSelected] = useState<string | null>(params.get("t"))
  const [lastQuery, setLastQuery] = useState(params.get("t"))
  if (lastQuery !== params.get("t")) {
    setLastQuery(params.get("t"))
    setSelected(params.get("t"))
  }
  const choose = (id: string) => {
    setSelected(id)
    router.replace(`/panel/para-llevar?t=${encodeURIComponent(id)}`, {
      scroll: false,
    })
  }
  const [creating, setCreating] = useState(false)
  const [filter, setFilter] = useState("activas")
  const [search, setSearch] = useState("")
  const takeaways = useRecogidas(scope)
  const active =
    takeaways.status === "ready"
      ? takeaways.data.filter(
          (t) => !["picked_up", "cancelled"].includes(t.status),
        )
      : []
  const current =
    takeaways.status === "ready"
      ? takeaways.data.find((t) => t.id === selected)
      : null
  return (
    <div className="space-y-5">
      <PageHeading
        title="Recogidas a su hora"
        eyebrow={`${location?.name} · En directo · ${timeOf(now, restaurant.timezone)}`}
        description="Pedidos de teléfono, mostrador y web. El consumo se registra al entregar, sin marcarlo como cobrado."
        actions={
          <Button className="h-12" onClick={() => setCreating(!creating)}>
            {creating ? "Cerrar nuevo pedido" : "Nuevo para llevar"}
          </Button>
        }
      />
      <EnlacesServicio />
      <SummaryStrip
        label="Recogidas pendientes"
        items={[
          {
            label: "Por aceptar",
            value:
              takeaways.status === "ready"
                ? active.filter((t) => t.status === "pending").length
                : "…",
            loading: takeaways.status === "loading",
          },
          {
            label: "En preparación",
            value:
              takeaways.status === "ready"
                ? active.filter((t) => t.status === "accepted").length
                : "…",
            loading: takeaways.status === "loading",
          },
          {
            label: "Listos",
            value:
              takeaways.status === "ready"
                ? active.filter((t) => t.status === "ready").length
                : "…",
            loading: takeaways.status === "loading",
            tone: "success",
          },
        ]}
      />
      {creating ? (
        <NuevoParaLlevar
          scope={scope}
          onCreated={(id) => {
            setCreating(false)
            choose(id)
          }}
        />
      ) : null}
      <div className="flex flex-wrap gap-3">
        <label className="min-w-48 flex-1 text-sm">
          Buscar cliente o referencia
          <Input
            className="h-12"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        <label className="text-sm">
          Estado
          <Desplegable
            className="min-h-12"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="activas">Recogidas activas</option>
            <option value="todas">Todo el historial</option>
          </Desplegable>
        </label>
      </div>
      <EstadoLectura live={takeaways} label="los pedidos para llevar">
        {(data) => (
          <section
            className="superficie divide-y"
            aria-label="Lista de recogidas"
          >
            {data
              .filter(
                (t) =>
                  (filter === "todas" ||
                    !["picked_up", "cancelled"].includes(t.status)) &&
                  `${t.guestName} ${t.reference}`
                    .toLocaleLowerCase("es")
                    .includes(search.toLocaleLowerCase("es")),
              )
              .sort((a, b) => a.pickupAt - b.pickupAt)
              .map((t) => (
                <button
                  type="button"
                  key={t.id}
                  aria-pressed={selected === t.id}
                  className="flex min-h-20 w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-surface-raised aria-pressed:bg-surface-raised"
                  onClick={() => choose(t.id)}
                >
                  <span className="cifra text-lg">
                    {timeOf(t.pickupAt, restaurant.timezone)}
                    <span className="block text-xs text-muted-foreground">
                      {localDate(t.pickupAt, restaurant.timezone)}
                    </span>
                  </span>
                  <span className="min-w-32 flex-1">
                    <span className="block font-medium">{t.guestName}</span>
                    <span className="cifra text-xs text-muted-foreground">
                      {t.reference}
                    </span>
                  </span>
                  <span
                    className={
                      t.status === "ready"
                        ? "text-success"
                        : t.pickupAt < now && t.status === "accepted"
                          ? "text-warning"
                          : "text-muted-foreground"
                    }
                  >
                    ● {TAKEAWAY_STATUS_LABEL[t.status]}
                  </span>
                  <span className="cifra">{euros(t.totalCents)}</span>
                </button>
              ))}
            {!data.length ? (
              <p className="p-5 text-muted-foreground">
                Todavía no hay pedidos para llevar.
              </p>
            ) : null}
          </section>
        )}
      </EstadoLectura>
      {selected ? (
        current ? (
          <DetalleRecogida key={current.id} scope={scope} takeaway={current} />
        ) : (
          <Notice>
            No se puede comprobar el pedido seleccionado. Recarga el listado
            antes de cambiarlo.
          </Notice>
        )
      ) : null}
    </div>
  )
}

function NuevoParaLlevar({
  scope,
  onCreated,
}: {
  scope: Alcance
  onCreated: (id: string) => void
}) {
  const { restaurant } = usePanel()
  const now = useNow()
  const [date, setDate] = useState(localDate(now, restaurant.timezone))
  const [time, setTime] = useState("")
  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [email, setEmail] = useState("")
  const [language, setLanguage] = useState("es")
  const [source, setSource] = useState<"phone" | "walk_in">("phone")
  const settings = useReservationSettings(
    scope.restaurantId,
    scope.locationId,
    restaurant.timezone,
  )
  const floor = useAjustesSala(scope)
  const carta = useCarta(scope)
  const slots =
    settings.status === "ready" && floor.status === "ready" && date
      ? pickupSlots(
          settings.data.config,
          floor.data.takeaway,
          date,
          now,
          {},
          true,
        )
      : []
  const slot = slots.find((s) => s.time === time && s.available)
  const blocked =
    !name.trim() || !phone.trim()
      ? "Escribe el nombre y teléfono del cliente."
      : floor.status !== "ready"
        ? "No se puede leer la configuración de recogidas."
        : !floor.data.takeaway.enabled
          ? "Para llevar está desactivado en este local."
          : !slot
            ? "Elige una hora futura dentro del turno de recogida."
            : null
  return (
    <section className="space-y-4">
      <div className="superficie space-y-4 p-4">
        <h2 className="text-lg font-semibold">Nuevo pedido para llevar</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            Nombre
            <Input
              className="h-12"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label>
            Teléfono
            <Input
              className="h-12"
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
          </label>
          <label>
            Correo opcional
            <Input
              className="h-12"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </label>
          <label>
            Origen
            <Desplegable
              className="min-h-12"
              value={source}
              onChange={(e) => setSource(e.target.value as typeof source)}
            >
              <option value="phone">Teléfono</option>
              <option value="walk_in">Mostrador</option>
            </Desplegable>
          </label>
          <label>
            Idioma
            <Desplegable
              className="min-h-12"
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
            >
              <option value="es">Castellano</option>
              <option value="ca">Catalán</option>
              <option value="en">Inglés</option>
            </Desplegable>
          </label>
          <label>
            Día de recogida
            <Input
              className="h-12"
              type="date"
              value={date}
              min={localDate(now, restaurant.timezone)}
              onChange={(e) => {
                setDate(e.target.value)
                setTime("")
              }}
            />
          </label>
        </div>
        <EstadoLectura live={floor} label="la configuración de sala">
          {() => null}
        </EstadoLectura>
        <EstadoLectura live={settings} label="los turnos de recogida">
          {() => (
            <label className="block">
              Hora de recogida
              <Desplegable
                className="min-h-12"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              >
                <option value="">Elige hora</option>
                {slots
                  .filter((s) => s.available)
                  .map((s) => (
                    <option key={s.startAt} value={s.time}>
                      {s.time} · {s.shift}
                      {s.wallDate !== date ? " · Día siguiente" : ""}
                    </option>
                  ))}
              </Desplegable>
            </label>
          )}
        </EstadoLectura>
        <p className="text-xs text-muted-foreground">
          El personal puede superar la antelación y capacidad de la web. El
          servidor vuelve a comprobar el turno. Los menús se validan a la hora
          de recogida.
        </p>
      </div>
      <EstadoLectura live={carta} label="la carta para llevar">
        {(data) => (
          <Pedido
            carta={data}
            timezone={restaurant.timezone}
            now={slot?.startAt ?? now}
            takeaway
            blocked={blocked}
            onSend={async (lines, _total, fire, notes) => {
              if (blocked) throw new Error(blocked)
              const result = await llamarSala("crearParaLlevar", {
                ...scope,
                date,
                time,
                guestName: name,
                phone,
                email,
                language: language as "es" | "ca" | "en",
                source,
                lines,
                notes,
                fire,
              })
              if (result.status === "rejected")
                throw new Error(problemasPedido(result.problems))
              onCreated(result.takeawayId)
            }}
          />
        )}
      </EstadoLectura>
    </section>
  )
}

function DetalleRecogida({
  scope,
  takeaway,
}: {
  scope: Alcance
  takeaway: Takeaway & { id: string }
}) {
  const { restaurant } = usePanel()
  const [reason, setReason] = useState("")
  const [adding, setAdding] = useState(false)
  const op = useOperacion()
  const carta = useCarta(scope)
  const active = !["picked_up", "cancelled"].includes(takeaway.status)
  return (
    <section className="space-y-4">
      <div className="superficie space-y-4 p-4">
        <h2 className="text-xl font-semibold">
          {takeaway.guestName} · {takeaway.reference}
        </h2>
        <p>
          {takeaway.phone} · {timeOf(takeaway.pickupAt, restaurant.timezone)} ·{" "}
          {TAKEAWAY_STATUS_LABEL[takeaway.status]}
        </p>
        {takeaway.notes ? <p>{takeaway.notes}</p> : null}
        {op.feedback}
        <label className="block">
          Motivo de anulación
          <Input
            className="h-12"
            maxLength={200}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </label>
        <div className="flex flex-wrap gap-2">
          {TAKEAWAY_TRANSITIONS[takeaway.status].map((status) => (
            <Button
              key={status}
              variant="outline"
              className="h-12"
              disabled={op.busy || (status === "cancelled" && !reason.trim())}
              onClick={() =>
                void op.run(async () => {
                  await llamarSala("cambiarEstadoParaLlevar", {
                    ...scope,
                    takeawayId: takeaway.id,
                    status: status as
                      | "accepted"
                      | "ready"
                      | "picked_up"
                      | "cancelled",
                    reason,
                  })
                  return status === "picked_up"
                    ? "Entregado. Consumo registrado, sin registrar cobro."
                    : `Pedido ${TAKEAWAY_STATUS_LABEL[status]}.`
                })
              }
            >
              {status === "accepted"
                ? takeaway.status === "pending"
                  ? "Aceptar pedido"
                  : "Volver a preparar"
                : status === "ready"
                  ? "Marcar listo"
                  : status === "picked_up"
                    ? "Entregar al cliente"
                    : "Anular con motivo"}
            </Button>
          ))}
          {active && takeaway.status !== "pending" ? (
            <Button
              variant="outline"
              className="h-12"
              onClick={() => setAdding(!adding)}
            >
              Añadir platos
            </Button>
          ) : null}
        </div>
      </div>
      <HistorialPedido
        scope={scope}
        kind="takeawayId"
        id={takeaway.id}
        active={active}
      />
      {adding ? (
        <EstadoLectura live={carta} label="la carta">
          {(data) => (
            <Pedido
              carta={data}
              timezone={restaurant.timezone}
              now={takeaway.pickupAt}
              takeaway
              blocked={
                !active || takeaway.status === "pending"
                  ? "El pedido ya no admite platos. Comprueba su estado."
                  : null
              }
              onSend={async (lines, total, fire, note) => {
                if (!active || takeaway.status === "pending")
                  throw new Error("El pedido ya no admite platos.")
                const r = await llamarSala("enviarPedido", {
                  ...scope,
                  takeawayId: takeaway.id,
                  lines,
                  expectedTotalCents: total,
                  fire,
                  note,
                })
                if (r.status === "rejected")
                  throw new Error(problemasPedido(r.problems))
              }}
            />
          )}
        </EstadoLectura>
      ) : null}
    </section>
  )
}
