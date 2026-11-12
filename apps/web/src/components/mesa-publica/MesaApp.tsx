"use client"
import { useRef, useState, useSyncExternalStore } from "react"
import { menuUi, ORDER_PROBLEM_TEXT, PedirDesdeMesaInputSchema, OrderLineInputSchema, sha256Hex, type CallableInput, type OrderLineInput } from "@llenamos/core"
import { usePublic } from "@/components/publica/PublicContext"
import { PublicShell } from "@/components/publica/PublicShell"
import { Button } from "@/components/ui/button"
import { Notice } from "@/components/common/notice"
import { useMenu } from "@/lib/carta/hooks"
import { definitiveRejection } from "@/lib/comandero/borrador"
import { Desplegable } from "@/components/common/desplegable"
import { Textarea } from "@/components/ui/textarea"
import { ServiceError } from "@/lib/carta/callables"
import { reviewOrder } from "@/lib/mesa-publica/pedido"
import { orderPriceSignature } from "@llenamos/core"
import { callMesa } from "@/lib/mesa-publica/pedido"
import { usePublicCall } from "@/lib/mesa-publica/consulta"
import { publicText } from "@/lib/mesa-publica/textos"
import { CartShortcut } from "@/components/mesa-publica/CartShortcut"
import { useNow } from "@/lib/use-now"
import { euros } from "@/lib/carta/forms"
import { Catalog } from "./Catalog"
import { Cart } from "./Cart"
import { OrderLines } from "./OrderLines"
import { MenuError, NoMenu } from "./MenuState"
const subscribeHydration = () => () => {}
export function MesaApp({ link }: { link: CallableInput<"verMesaPublica"> }) {
  const hydrated = useSyncExternalStore(subscribeHydration, () => true, () => false)
  return hydrated ? <MesaAppClient key={`${link.tableId}:${link.token}`} link={link} /> : <NoMenu loading />
}
function MesaAppClient({ link }: { link: CallableInput<"verMesaPublica"> }) {
  const { lang } = usePublic()
  const now = useNow()
  const state = usePublicCall("verMesaPublica", link, true)
  const mesa = state.data
  const menu = useMenu(mesa?.publicMenuId ?? null, { slug: link.slug, locationId: link.locationId })
  const storageKey = `llenamos:mesa:borrador:${link.slug}:${link.locationId}:${link.tableId}:${sha256Hex(link.token)}`
  type Draft = { lines: OrderLineInput[]; cartSession: string | null; destination?: string; note: string; submission: CallableInput<"pedirDesdeMesa"> | null }
  const [draft, setDraft] = useState<Draft>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") as Draft | null
      if (saved) return { ...saved, lines: saved.lines.map(l => OrderLineInputSchema.parse(l)), submission: saved.submission ? PedirDesdeMesaInputSchema.parse(saved.submission) : null }
    } catch { /* Un borrador incompatible no se envía. */ }
    return { lines: [], cartSession: null, note: "", submission: null }
  })
  const [storageError, setStorageError] = useState(false)
  function saveDraft(next: Draft) {
    try { localStorage.setItem(storageKey, JSON.stringify(next)); setStorageError(false) }
    catch { setStorageError(true); setDraft(next); return false }
    setDraft(next)
    return true
  }
  const { lines, cartSession } = draft
  const setLines = (value: OrderLineInput[]) => saveDraft({ ...draft, lines: value })
  const [reason, setReason] = useState<"water" | "cutlery" | "napkins" | "order" | "other">("other")
  const [serviceNote, setServiceNote] = useState("")
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false),
    [error, setError] = useState<unknown>(null),
    [message, setMessage] = useState("")
  const uncertain = !!draft.submission
  const lock = useRef(false)
  const currentSession = mesa?.session?.sessionId ?? null
  const stale = lines.length > 0 && (cartSession !== currentSession || (!!draft.destination && draft.destination !== mesa?.destination))
  const blocked = pending || uncertain || stale || !mesa?.canOrder || !!state.error
  async function deliver(input: CallableInput<"pedirDesdeMesa">) {
    if (lock.current) return
    lock.current = true
    setPending(true); setError(null); setMessage("")
    if (!saveDraft({ ...draft, submission: input })) { lock.current = false; setPending(false); setError(new Error("Activa el almacenamiento del navegador antes de enviar.")); return }
    try {
      const result = await callMesa("pedirDesdeMesa", input)
      if (result.status === "rejected") {
        saveDraft({ ...draft, submission: null })
        setRevision(n => n + 1)
        setError(new Error(`${result.problems.map(p => ORDER_PROBLEM_TEXT[lang][p.code]).join(" ")} ${publicText(lang, "serverTotal")}: ${euros(result.totalCents, lang)}`))
      } else {
        saveDraft({ lines: [], cartSession: null, note: "", submission: null })
        setMessage(menuUi(lang, result.status === "pending_approval" ? "orderPending" : "orderSent"))
        state.refresh()
      }
    } catch (e) {
      setError(e)
      if (definitiveRejection(e)) saveDraft({ ...draft, submission: null })
      state.refresh()
    } finally { lock.current = false; setPending(false) }
  }
  async function send(total: number, note: string) {
    if (lock.current || blocked || !currentSession) return
    lock.current = true
    try {
      const fresh = await callMesa("verMesaPublica", link)
      if (!fresh.canOrder || fresh.session?.sessionId !== cartSession || (draft.destination && fresh.destination !== draft.destination)) {
        state.refresh()
        throw new ServiceError("stale", publicText(lang, "noSession"))
      }
      lock.current = false
      const expectedPrices = menu.status === "ready" && menu.data ? orderPriceSignature(reviewOrder(menu.data, lines, "table", now.getTime()).lines) : undefined
      await deliver({ expectedPrices, ...link, sessionId: cartSession!, expectedDestination: draft.destination, requestId: crypto.randomUUID(), lines, expectedTotalCents: total, language: lang, note, website: "" })
    } catch (e) { lock.current = false; setError(e) }
  }
  async function notify(kind: "call_waiter" | "request_bill") {
    if (lock.current || !mesa || state.error) return
    lock.current = true
    setPending(true)
    setError(null)
    setMessage("")
    try {
      await callMesa("avisarDesdeMesa", { ...link, sessionId: currentSession, kind, reason, note: serviceNote, website: "" })
      setMessage(publicText(lang, "confirmed"))
      state.refresh()
    } catch (e) {
      setError(e)
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  return (
    <PublicShell
      title={menuUi(lang, "menu")}
      name={mesa?.restaurantName ?? null}
      brandColor={menu.status === "ready" ? (menu.data?.brandColor ?? null) : null}
      subtitle={mesa ? `${mesa.locationName} · ${mesa.tableName}` : null}
    >
      {!mesa && <h1 className="mb-5 text-2xl font-semibold">{menuUi(lang, "menu")}</h1>}
      {!mesa && !state.error && <NoMenu loading />}
      {!!state.error && <MenuError error={state.error} />}
      {!!error && <MenuError error={error} />}
      <div className="my-4">
        <Button
          variant="outline"
          className="h-12 w-full"
          onClick={() => {
            state.refresh()
          }}
        >
          {publicText(lang, "refresh")}
        </Button>
      </div>
      {storageError && <Notice tone="error">No se puede guardar el borrador en este navegador. Conserva esta página abierta.</Notice>}
      {lines.length > 0 && !storageError && <p className="my-3 text-xs text-muted-foreground">Borrador guardado en este navegador para esta mesa.</p>}
      {message && <Notice tone="success">{message}</Notice>}
      {mesa && (
        <>
          {mesa.callWaiter && <div className="superficie my-4 space-y-3 p-4"><label className="block text-sm">Motivo de la llamada<Desplegable className="min-h-12" value={reason} onChange={e => setReason(e.target.value as typeof reason)}><option value="other">Llamar al camarero</option><option value="water">Agua</option><option value="cutlery">Cubiertos</option><option value="napkins">Servilletas</option><option value="order">Quiero pedir</option></Desplegable></label><label className="block text-sm">Nota para el camarero<Textarea value={serviceNote} maxLength={200} onChange={e => setServiceNote(e.target.value)} /></label></div>}
          <div className="mb-5 grid grid-cols-2 gap-3">
            {mesa.callWaiter && (
              <Button
                className="h-12"
                variant="outline"
                disabled={pending || !!state.error}
                onClick={() => void notify("call_waiter")}
              >
                {menuUi(lang, "callWaiter")}
              </Button>
            )}
            {mesa.requestBill && (
              <Button
                className="h-12"
                variant="outline"
                disabled={pending || !mesa.session || !!state.error}
                onClick={() => void notify("request_bill")}
              >
                {menuUi(lang, "requestBill")}
              </Button>
            )}
          </div>
          {mesa.canViewPayment && (
            <Button asChild variant="outline" className="mb-5 min-h-12 w-full">
              <a href={`/p/${link.slug}/${link.locationId}/mesa/${link.tableId}?t=${encodeURIComponent(link.token)}`} rel="noreferrer">
                {{ es: "Consultar la cuenta preparada", ca: "Consultar el compte preparat", en: "View the prepared bill" }[lang]}
              </a>
            </Button>
          )}
          {!mesa.canOrder && <Notice>{menuUi(lang, mesa.session ? "orderingOff" : "tableNotOpen")}</Notice>}
        </>
      )}
      {uncertain && (
        <div className="my-4 space-y-3">
          <Notice tone="warning">{publicText(lang, "uncertain")}</Notice>
          <Button
            variant="outline"
            className="min-h-12 whitespace-normal"
            disabled={pending}
            onClick={() => draft.submission && void deliver(draft.submission)}
          >
            Recuperar resultado del envío

          </Button>
        </div>
      )}
      {stale && (
        <Notice
          tone="warning"
          action={
            <Button variant="outline" className="h-12" onClick={() => { saveDraft({ ...draft, cartSession: currentSession, destination: mesa?.destination }); setRevision(n => n + 1) }}>
              Revisar destino de este borrador
            </Button>
          }
        >
          {publicText(lang, "noSession")}
        </Notice>
      )}
      {menu.status === "ready" && menu.data ? (
        <>
          <CartShortcut count={lines.length} lang={lang} />
          <Catalog
            menu={menu.data}
            language={lang}
            channel="table"
            at={now.getTime()}
            canAdd={!blocked}
            onAdd={(line) => {
              if (lines.length < 50) saveDraft({ ...draft, lines: [...lines, line], ...(lines.length === 0 ? { cartSession: currentSession, destination: mesa?.destination } : {}) })
            }}
          />
          <Cart
            draftNote={draft.note}
            onNoteChange={note => saveDraft({ ...draft, note })}
            revision={revision}
            menu={menu.data}
            lang={lang}
            channel="table"
            at={now.getTime()}
            lines={lines}
            onChange={setLines}
            pending={pending}
            blocked={uncertain || stale || !mesa?.canOrder || !!state.error}
            onSend={(total, note) => void send(total, note)}
          />
        </>
      ) : mesa ? (
        menu.status === "error" ? (
          <MenuError error={menu.error} />
        ) : (
          <NoMenu loading={menu.status === "loading"} />
        )
      ) : null}
      {mesa?.session && (
        <section className="superficie my-6 p-4">
          <h2 className="text-lg font-semibold">{menuUi(lang, "alreadyOrdered")}</h2>
          <OrderLines lines={mesa.session.lines} lang={lang} />
          <div className="flex justify-between border-t pt-4">
            <span>{menuUi(lang, "total")}</span>
            <strong className="cifra">{euros(mesa.session.totalCents, lang)}</strong>
          </div>
        </section>
      )}
    </PublicShell>
  )
}
