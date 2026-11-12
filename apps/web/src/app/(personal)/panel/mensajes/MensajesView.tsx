"use client"

import { MESSAGE_CHANNELS, type MessageChannel } from "@llenamos/core"
import { ChatCircleTextIcon, EnvelopeSimpleIcon, MagnifyingGlassIcon, WhatsappLogoIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { SummaryStrip } from "@/components/common/summary-strip"
import { EmptyState } from "@/components/common/empty-state"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { SegmentedControl } from "@/components/common/segmented-control"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Desplegable } from "@/components/common/desplegable"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"
import { useMessages } from "@/lib/config/hooks"
import { llamarCore } from "@/lib/data/callables"
import { useCloseOnHide } from "@/lib/open-state"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import { formatFull, formatRelative, plural } from "@/lib/format"
import * as B from "@/lib/mensajes/bandeja"
import { useNow } from "@/lib/use-now"

const MAX = 300

export function MensajesView() {
  return (
    <RequirePermission permission="mensajes.ver" what="los mensajes">
      <RequireModule module="reservations">
        <Mensajes />
      </RequireModule>
    </RequirePermission>
  )
}

const TONE_DOT: Record<B.StatusTone, string> = {
  ok: "bg-success border-success",
  local: "bg-transparent border-warning",
  waiting: "bg-transparent border-muted-foreground border-dashed",
  error: "bg-destructive border-destructive",
  muted: "bg-ash border-ash",
}

const TONE_TEXT: Record<B.StatusTone, string> = {
  ok: "text-success",
  local: "text-warning",
  waiting: "text-soft-foreground",
  error: "text-destructive",
  muted: "text-muted-foreground",
}

function StatusWord({ status }: { status: B.MessageDoc["status"] }) {
  const tone = B.statusTone(status)
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs", TONE_TEXT[tone])}>
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full border", TONE_DOT[tone])} />
      {B.statusLabel(status)}
    </span>
  )
}

function ChannelIcon({ channel }: { channel: MessageChannel }) {
  return channel === "whatsapp" ? <WhatsappLogoIcon aria-hidden className="size-4" /> : <EnvelopeSimpleIcon aria-hidden className="size-4" />
}

function Mensajes() {
  const { restaurant } = usePanel()
  const live = useMessages(restaurant.id, MAX)
  const [filter, setFilter] = useState<B.InboxFilter>("all")
  const [channel, setChannel] = useState<MessageChannel | "all">("all")
  const [text, setText] = useState("")
  const [openId, setOpenId] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const now = useNow().getTime()

  const all = useMemo(() => (live.status === "ready" ? live.data : []), [live])
  const counts = useMemo(() => B.countByFilter(all), [all])
  const shown = useMemo(() => B.filterInbox(all, { filter, channel, text }), [all, filter, channel, text])
  const due = B.dueCount(all, now)
  const open = all.find((m) => m.id === openId) ?? null
  useCloseOnHide(() => setOpenId(null))

  const [order, setOrder] = useState("recent")
  const [page, setPage] = useState(1)
  const sorted = [...shown].sort((a, b) => (order === "guest" || order === "guest-desc")
    ? (B.guestOf(a) ?? "").localeCompare(B.guestOf(b) ?? "", "es") * (order === "guest-desc" ? -1 : 1)
    : order === "oldest" ? a.sendAt - b.sendAt : b.sendAt - a.sendAt)
  // Los filtros pueden acortar la lista sin perder la página elegida.
  const currentPage = Math.min(page, Math.max(1, Math.ceil(sorted.length / 50)))
  const visible = sorted.slice((currentPage - 1) * 50, currentPage * 50)

  async function procesar() {
    setPending(true)
    setError(null)
    try {
      const r = await llamarCore("procesarMensajesPendientes", { restaurantId: restaurant.id })
      toast.success(B.processSummary(r))
    } catch (e) {
      setError(describeError(e))
    } finally {
      setPending(false)
    }
  }

  const header = (
    <PageHeading
      eyebrow={`${restaurant.name} · Mensajes`}
      title={
        live.status === "ready"
          ? counts.problems > 0
            ? `${plural(counts.problems, "mensaje no ha salido", "mensajes no han salido")}`
            : due > 0
              ? `${plural(due, "mensaje espera", "mensajes esperan")} para salir`
              : "Todos los mensajes al día"
          : "Mensajes"
      }
      description="Lo que se envía a tus clientes por correo y WhatsApp: confirmaciones, recordatorios, cancelaciones y peticiones de reseña, con el texto tal cual les llega."
      actions={
        <>
          {live.status === "ready" ? <LiveIndicator /> : null}
          <Button className="shadow-soft" size="lg" onClick={() => void procesar()} disabled={pending}>
            {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
            {pending ? "Procesando…" : "Procesar pendientes"}
          </Button>
        </>
      }
    />
  )

  if (live.status === "loading") {
    return (
      <>
        {header}
        <LoadingBlock label="Cargando los mensajes…" className="flex flex-col gap-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </LoadingBlock>
      </>
    )
  }
  if (live.status === "error") {
    return (
      <>
        {header}
        <LiveError title="No se han podido cargar los mensajes" error={live.error} />
      </>
    )
  }

  return (
    <>
      {header}
      <SummaryStrip className="mb-6" label="Resumen de mensajes" items={[
        { label: "Mensajes", value: all.length, hint: "confirmaciones y avisos" },
        { label: "Capturados", value: counts.captured, hint: "guardados en modo local" },
        { label: "Para salir", value: due, hint: "pendientes de procesar" },
        { label: "Con problemas", value: counts.problems, hint: "necesitan revisión" },
      ]} />
      {error ? (
        <Notice tone="error" title="No se han procesado los pendientes" detail={error.code} className="mb-4">
          {error.message}
        </Notice>
      ) : null}
      {counts.captured > 0 ? (
        <Notice tone="info" className="mb-4">
          Estás en modo local: los mensajes no salen de verdad. Quedan capturados aquí con el texto que recibiría el cliente.
        </Notice>
      ) : null}

      <div className="mb-4 flex min-w-0 flex-col gap-3">
        <div className="no-scrollbar -mx-4 min-w-0 overflow-x-auto px-4 sm:mx-0 sm:px-0">
          <SegmentedControl
            label="Estado de los mensajes"
            value={filter}
            onValueChange={setFilter}
            options={B.INBOX_FILTERS.map((f) => ({ value: f, label: `${B.INBOX_FILTER_LABEL[f]} ${counts[f]}` }))}
            className="w-max"
          />
        </div>
        <div className="flex min-w-0 flex-wrap gap-2 sm:justify-end">
          <Desplegable aria-label="Canal" value={channel} onChange={(e) => setChannel(e.target.value as MessageChannel | "all")} className="h-9 w-auto min-w-44">
            <option value="all">Todos los canales</option>
            {MESSAGE_CHANNELS.map((c) => (
              <option key={c} value={c}>
                {B.channelLabel(c) === "correo" ? "Correo" : B.channelLabel(c)}
              </option>
            ))}
          </Desplegable>
          <InputGroup className="min-w-0 flex-1 lg:w-64 lg:flex-none">
            <InputGroupAddon>
              <MagnifyingGlassIcon aria-hidden />
            </InputGroupAddon>
            <InputGroupInput type="search" aria-label="Buscar mensajes" placeholder="Cliente, teléfono o texto" value={text} onChange={(e) => setText(e.target.value)} />
          </InputGroup>
        </div>
      </div>

      {all.length === 0 ? (
        <EmptyState
          icon={<ChatCircleTextIcon />}
          title="Aún no se ha enviado ningún mensaje"
          description="Cuando alguien reserve, aquí verás su confirmación y, el día antes, su recordatorio."
        />
      ) : shown.length === 0 ? (
        <EmptyState icon={<MagnifyingGlassIcon />} title="Ningún mensaje coincide" description="Prueba con otro filtro o quita la búsqueda." />
      ) : (
        <section className="superficie @container/mensajes overflow-hidden" aria-label="Bandeja de mensajes">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b bg-surface-sunken/40 px-5 py-3">
            <h2 className="text-base font-semibold">{plural(shown.length, "mensaje", "mensajes")}</h2>
            <Desplegable aria-label="Ordenar mensajes" value={order} onChange={(e) => setOrder(e.target.value)} className="h-9 w-auto min-w-52">
              <option value="recent">Más recientes primero</option>
              <option value="oldest">Más antiguos primero</option>
              <option value="guest">Cliente de A a Z</option>
              <option value="guest-desc">Cliente de Z a A</option>
            </Desplegable>
          </div>
          <ul className="divide-y">
            {visible.map((m) => (
              <li key={m.id}>
                <button type="button" onClick={() => setOpenId(m.id)}
                  aria-label={`Abrir ${B.messageTitle(m)} para ${B.guestOf(m) ?? m.to}`}
                  className={cn("grid w-full grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-5 py-4 text-left transition-colors hover:bg-surface-raised @xl/mensajes:grid-cols-[2.5rem_minmax(0,1fr)_9rem_8rem]", m.status === "cancelled" && "opacity-60")}>
                  <span className="flex size-10 items-center justify-center rounded-full border bg-surface-raised text-soft-foreground"><ChannelIcon channel={m.channel} /></span>
                  <span className="min-w-0">
                    <span className="block truncate text-[15px] font-medium">{B.guestOf(m) ?? "Sin nombre"}</span>
                    <span className="mt-1 block text-sm text-muted-foreground">{B.messageTitle(m)}</span>
                    <span className="cifra mt-1 block truncate text-xs text-muted-foreground">{m.to}</span>
                  </span>
                  <span className="col-start-2 @xl/mensajes:col-start-auto"><StatusWord status={m.status} /></span>
                  <time dateTime={new Date(m.sendAt).toISOString()} title={formatFull(new Date(m.sendAt))}
                    className="col-start-2 text-xs text-muted-foreground @xl/mensajes:col-start-auto @xl/mensajes:text-right">
                    {formatRelative(new Date(m.sendAt), new Date(now))}
                  </time>
                </button>
              </li>
            ))}
          </ul>
          {sorted.length > 50 ? <div className="flex flex-wrap items-center justify-between gap-3 border-t px-5 py-3">
            <span className="cifra text-xs text-muted-foreground">Página {currentPage} de {Math.ceil(sorted.length / 50)}</span>
            <div className="flex gap-2">
              <Button variant="outline" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>Anterior</Button>
              <Button variant="outline" disabled={currentPage * 50 >= sorted.length} onClick={() => setPage(currentPage + 1)}>Siguiente</Button>
            </div>
          </div> : null}
        </section>
      )}
      {all.length >= MAX ? <p className="mt-3 text-xs text-muted-foreground">Se enseñan los {MAX} mensajes más recientes.</p> : null}

      <Sheet open={open !== null} onOpenChange={(o) => !o && setOpenId(null)}>
        <SheetContent className="overflow-y-auto data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
          {open ? (
            <>
              <SheetHeader>
                <SheetTitle>{B.messageTitle(open)}</SheetTitle>
                <SheetDescription>
                  Para {B.guestOf(open) ?? "el cliente"} · <span className="cifra break-all">{open.to}</span>
                </SheetDescription>
              </SheetHeader>
              <div className="flex flex-col gap-4 px-4 pb-6">
                <div className="flex flex-col gap-1">
                  <StatusWord status={open.status} />
                  <p className="text-sm text-muted-foreground">{B.statusExplanation(open, now)}</p>
                </div>
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                  <dt className="text-muted-foreground">Sale</dt>
                  <dd className="cifra">{formatFull(new Date(open.sendAt))}</dd>
                  <dt className="text-muted-foreground">Idioma</dt>
                  <dd className="cifra uppercase">{open.language}</dd>
                  {typeof open.data.reference === "string" ? (
                    <>
                      <dt className="text-muted-foreground">Reserva</dt>
                      <dd className="cifra">{open.data.reference}</dd>
                    </>
                  ) : null}
                  <dt className="text-muted-foreground">Intentos</dt>
                  <dd className="cifra">{open.attempts}</dd>
                  {open.provider ? (
                    <>
                      <dt className="text-muted-foreground">Proveedor</dt>
                      <dd className="cifra">{open.provider}</dd>
                    </>
                  ) : null}
                </dl>
                {open.rendered ? (
                  <figure className="rounded-xl border bg-background p-4">
                    <figcaption className="mb-2 text-xs text-muted-foreground">Tal cual le llega al cliente</figcaption>
                    {open.rendered.subject ? <p className="mb-2 font-semibold">{open.rendered.subject}</p> : null}
                    <p className="text-sm break-words whitespace-pre-wrap text-soft-foreground">{open.rendered.body}</p>
                  </figure>
                ) : (
                  <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">
                    El texto se prepara cuando el mensaje se procesa. Hasta entonces no hay nada que enseñar.
                  </p>
                )}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  )
}
