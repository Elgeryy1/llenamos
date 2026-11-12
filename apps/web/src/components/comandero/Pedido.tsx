"use client"

import {
  OFFLINE_MESSAGES, displayPrice, orderPriceSignature,
  isDailyMenuAvailable,
  priceOrder,
  type FireMode,
  type OrderLineInput,
} from "@llenamos/core"
import { IntencionGuardada } from "@/lib/sin-conexion/cliente"
import { useRef, useState } from "react"
import { Desplegable } from "@/components/common/desplegable"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Textarea } from "@/components/ui/textarea"
import type { Carta } from "@/lib/comandero/datos"
import { useBorrador, definitiveRejection, type Envio } from "@/lib/comandero/borrador"
import { euros, problemasPedido, sumarRepetido } from "@/lib/comandero/modelo"
import { useCloseOnHide } from "@/lib/open-state"
import { Alergenos, PlatoForm } from "./OpcionesPlato"
import { MenuForm } from "./MenuForm"
import { useOperacion } from "./Servicio"

export function Pedido({
  carta,
  timezone,
  now,
  takeaway = false,
  blocked,
  review,
  onSend,
  draftKey, destination, repeatLines,
}: {
  draftKey?: string
  destination?: string
  repeatLines?: OrderLineInput[]
  carta: Carta
  timezone: string
  now: number
  takeaway?: boolean
  blocked?: string | null
  review?: React.ReactNode
  onSend: (
    lines: OrderLineInput[],
    total: number,
    fire: FireMode,
    note: string,
    requestId?: string,
    destination?: string,
    prices?: string,
  ) => Promise<void>
}) {
  const { draft, update, error: storageError } = useBorrador(draftKey, destination)
  const { lines, note, fire } = draft
  const setLines = (fn: (all: OrderLineInput[]) => OrderLineInput[]) => update({ ...draft, lines: fn(lines), reviewedTotal: null })
  const destinationChanged = lines.length > 0 && draft.destination !== destination

  const draftRef = useRef<HTMLElement | null>(null)
  const [search, setSearch] = useState("")
  const [category, setCategory] = useState("todas")
  const [editing, setEditing] = useState<{
    kind: "item" | "menu"
    id: string
    index?: number
  } | null>(null)
  const op = useOperacion()
  const frozen = op.busy || !!draft.pending
  const send = (submission: Envio) => op.run(async () => {
    if (!update({ ...draft, pending: submission })) throw new Error("Activa el almacenamiento del navegador antes de enviar.")
    try {
      await onSend(submission.lines, submission.total, submission.fire, submission.note, submission.requestId, submission.destination, submission.prices)
      update({ lines: [], note: "", fire: "auto", destination, reviewedTotal: null, pending: null })
      return "Pedido confirmado por el servidor."
    } catch (error) {
      if (error instanceof IntencionGuardada) {
        update({ lines: [], note: "", fire: "auto", destination, reviewedTotal: null, pending: null })
        return error.message || OFFLINE_MESSAGES.pending
      }
      if (definitiveRejection(error)) update({ ...draft, pending: null, reviewedTotal: null })
      throw error
    }
  })
  useCloseOnHide(() => setEditing(null))
  const catalog = {
    items: Object.fromEntries(carta.items.map((i) => [i.id, i])),
    dailyMenus: Object.fromEntries(carta.menus.map((m) => [m.id, m])),
  }
  const priced = priceOrder(lines, catalog, {
    channel: takeaway ? "takeaway" : "staff",
    now,
    timezone,
  })
  const item =
    editing?.kind === "item"
      ? carta.items.find((i) => i.id === editing.id)
      : null
  const menu =
    editing?.kind === "menu"
      ? carta.menus.find((m) => m.id === editing.id)
      : null
  const add = (line: OrderLineInput) => {
    setLines(all => editing?.index !== undefined ? all.map((existing, index) => index === editing.index ? line : existing) : sumarRepetido(all, line))
    setEditing(null)
  }
  const matches = (name: string) =>
    name.toLocaleLowerCase("es").includes(search.toLocaleLowerCase("es"))
  return (
    <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(17rem,0.8fr)]">
      <section
        className="superficie overflow-hidden"
        aria-label="Carta para pedir"
      >
        <div className="space-y-3 border-b p-4">
          <h2 className="text-lg font-semibold">Añadir al pedido</h2>
          <Input
            className="h-12"
            aria-label="Buscar en la carta"
            placeholder="Buscar plato o menú"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <Desplegable
            className="min-h-12"
            aria-label="Categoría"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          >
            <option value="todas">Toda la carta</option>
            {carta.categories
              .filter((c) => c.active)
              .sort((a, b) => a.sortOrder - b.sortOrder)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name.es}
                </option>
              ))}
            <option value="menus">Menús del día</option>
          </Desplegable>
        </div>
        <div className="divide-y">
          {category !== "menus"
            ? carta.items
                .filter(
                  (i) =>
                    i.active &&
                    !carta.categories.some(c => c.id === i.categoryId && !c.active) &&
                    (!takeaway || i.takeaway) &&
                    (category === "todas" || i.categoryId === category) &&
                    matches(i.name.es),
                )
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((i) => (
                  <div key={i.id} className="space-y-2 p-4">
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <p className="font-medium">{i.name.es}</p>
                        <p className="cifra text-sm text-soft-foreground">
                          {displayPrice(i).from ? "Desde " : ""}
                          {euros(displayPrice(i).priceCents)}
                        </p>
                      </div>
                      <Button
                        type="button"
                        aria-label={`${i.soldOut ? "Agotado" : "Añadir"} ${i.name.es}`}
                        variant="outline"
                        className="h-12 shrink-0"
                        disabled={i.soldOut || frozen || lines.length >= 50}
                        onClick={() => i.variants.length || i.modifierGroups.some(g => g.min > 0)
                          ? setEditing({ kind: "item", id: i.id })
                          : add({ kind: "item", itemId: i.id, quantity: 1, variantId: null, optionIds: [], notes: "", guest: null, course: i.course })}
                      >
                        {i.soldOut ? "Agotado" : "Añadir"}
                        <span className="sr-only"> {i.name.es}</span>
                      </Button>
                    </div>
                    <Button variant="ghost" className="h-12" disabled={frozen || i.soldOut} onClick={() => setEditing({ kind: "item", id: i.id })}>Opciones, nota y comensal<span className="sr-only"> de {i.name.es}</span></Button>
                    <Alergenos item={i} />
                  </div>
                ))
            : null}
          {category === "todas" || category === "menus"
            ? carta.menus
                .filter(
                  (m) =>
                    m.active && (!takeaway || m.takeaway) && matches(m.name.es),
                )
                .sort((a, b) => a.sortOrder - b.sortOrder)
                .map((m) => {
                  const available = isDailyMenuAvailable(m, now, timezone)
                  return (
                    <div
                      key={m.id}
                      className="flex items-center justify-between gap-3 p-4"
                    >
                      <div>
                        <p className="font-medium">{m.name.es}</p>
                        <p className="cifra text-sm">{euros(m.priceCents)}</p>
                        <p className="text-xs text-muted-foreground">
                          {m.from} a {m.to}
                          {available ? "" : " · Fuera de horario"}
                        </p>
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className="h-12"
                        disabled={!available || frozen || lines.length >= 50}
                        onClick={() => setEditing({ kind: "menu", id: m.id })}
                      >
                        Elegir menú
                      </Button>
                    </div>
                  )
                })
            : null}
          {!carta.items.length && !carta.menus.length ? (
            <p className="p-4 text-muted-foreground">
              No hay carta guardada en este local. El servidor debe publicar sus
              platos antes de pedir.
            </p>
          ) : null}
        </div>
      </section>
      <section
        ref={draftRef}
        tabIndex={-1}
        className="superficie scroll-mt-20 space-y-4 p-4 lg:sticky lg:top-20"
        aria-label="Pedido sin enviar"
      >
        <h2 className="text-lg font-semibold">
          Pedido sin enviar{" "}
          <span className="cifra text-muted-foreground">{lines.length}</span>
        </h2>
        {blocked ? (
          <Notice tone="warning">
            {blocked}
            {review}
          </Notice>
        ) : null}
        {op.feedback}
        {storageError ? <Notice tone="error">{storageError}</Notice> : null}
        {draftKey && lines.length > 0 && !storageError ? <p className="text-xs text-success">Borrador guardado en este navegador para tu cuenta y esta mesa.</p> : null}
        {destinationChanged ? <Notice tone="warning">El destino del borrador ha cambiado. Revisa la mesa y sus comensales.<Button variant="outline" className="mt-2 h-12" disabled={frozen} onClick={() => update({ ...draft, destination })}>Revisar destino del borrador</Button></Notice> : null}
        {draft.pending ? <Notice tone="warning">Hay un envío sin respuesta confirmada. Recupera su resultado con la misma clave antes de seguir.<Button variant="outline" className="mt-2 h-12" disabled={op.busy} onClick={() => void send(draft.pending!)}>Recuperar resultado del envío</Button></Notice> : null}
        {!lines.length && repeatLines?.length ? <Button variant="outline" className="h-12" disabled={frozen} onClick={() => update({ ...draft, lines: repeatLines, destination, reviewedTotal: null })}>Repetir última ronda</Button> : null}
        {!lines.length ? (
          <p className="text-sm text-muted-foreground">
            Añade platos o un menú. El borrador se guarda en este navegador.
          </p>
        ) : (
          <ul className="divide-y">
            {lines.map((line, index) => {
              const p = priced.lines.find((l) => l.index === index)
              const name =
                line.kind === "item"
                  ? catalog.items[line.itemId]?.name.es
                  : catalog.dailyMenus[line.dailyMenuId]?.name.es
              return (
                <li key={index} className="space-y-2 py-3">
                  <div className="flex justify-between gap-2">
                    <p className="font-medium">
                      {line.quantity} × {name ?? "No disponible"}
                    </p>
                    <Button
                      type="button"
                      variant="ghost"
                      className="h-12"
                      disabled={frozen}
                      onClick={() =>
                        setLines((all) => all.filter((_, i) => i !== index))
                      }
                      aria-label={`Quitar línea ${index + 1}`}
                    >
                      Quitar
                    </Button>
                  </div>
                  {line.kind === "item" ? <Button variant="ghost" className="h-12" disabled={frozen} onClick={() => setEditing({ kind: "item", id: line.itemId, index })}>Opciones, nota y comensal de la línea {index + 1}</Button> : null}
                  <div className="flex gap-2">
                    <Button variant="outline" className="h-12" disabled={frozen || line.quantity <= 1} aria-label={`Restar línea ${index + 1}`} onClick={() => setLines(all => all.map((l, i) => i === index ? { ...l, quantity: l.quantity - 1 } : l))}>−</Button>
                    <Button variant="outline" className="h-12" disabled={frozen || line.quantity >= 99} aria-label={`Sumar línea ${index + 1}`} onClick={() => setLines(all => all.map((l, i) => i === index ? { ...l, quantity: l.quantity + 1 } : l))}>+</Button>
                  </div>
                  {p ? (
                    <>
                      <p className="text-sm text-muted-foreground">
                        {[
                          p.variant?.name.es,
                          ...p.modifiers.map((m) => m.name.es),
                        ]
                          .filter(Boolean)
                          .join(", ")}
                      </p>
                      {p.components.map((c, n) => (
                        <p key={n} className="text-sm text-soft-foreground">
                          {c.name.es}
                          {c.variant ? ` · ${c.variant.name.es}` : ""}
                          {c.modifiers.map((m) => ` · ${m.name.es}`).join("")}
                        </p>
                      ))}
                      <p className="cifra">{euros(p.totalCents)}</p>
                    </>
                  ) : null}
                  {line.notes ? <p className="text-sm">{line.notes}</p> : null}
                  {line.guest ? (
                    <p className="text-xs">Comensal {line.guest}</p>
                  ) : null}
                </li>
              )
            })}
          </ul>
        )}
        {!priced.ok && lines.length ? (
          <Notice tone="warning">{problemasPedido(priced.problems)}</Notice>
        ) : null}
        <label className="block text-sm">
          Salida de los platos
          <Desplegable
            className="min-h-12"
            value={fire}
            onChange={(e) => update({ ...draft, fire: e.target.value as FireMode })}
            disabled={frozen}
          >
            <option value="auto">
              {takeaway
                ? "Según hora de recogida"
                : "Según los pases del local"}
            </option>
            <option value="all">Marchar todo ahora</option>
            <option value="hold">Retener la comida</option>
          </Desplegable>
        </label>
        <label className="block text-sm">
          Nota del envío
          <Textarea
            aria-label="Nota del envío"
            maxLength={200}
            value={note}
            onChange={(e) => update({ ...draft, note: e.target.value })}
            disabled={frozen}
          />
        </label>
        <p className="flex items-baseline justify-between gap-2">
          Total orientativo{" "}
          <strong className="cifra text-xl">{euros(priced.totalCents)}</strong>
        </p>
        <p className="text-xs text-muted-foreground">
          IVA incluido. El servidor comprueba el precio al enviar.
        </p>
        {lines.length > 0 && (draft.reviewedTotal !== priced.totalCents || draft.reviewedPrices !== orderPriceSignature(priced.lines)) ? <Button variant="outline" className="h-12 w-full" disabled={frozen || !priced.ok} onClick={() => update({ ...draft, reviewedTotal: priced.totalCents, reviewedPrices: orderPriceSignature(priced.lines) })}>Revisar total · {euros(priced.totalCents)}</Button> : null}
        <Button
          type="button"
          className="h-12 w-full"
          disabled={!lines.length || !priced.ok || !!blocked || destinationChanged || frozen || (draft.reviewedTotal !== priced.totalCents || draft.reviewedPrices !== orderPriceSignature(priced.lines))}
          onClick={() => void send({ requestId: crypto.randomUUID(), lines, total: priced.totalCents, fire, note, destination: draft.destination, prices: orderPriceSignature(priced.lines) })}
        >
          {op.busy ? "Enviando…" : "Enviar pedido"}
        </Button>
      </section>
      <Sheet
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
      >
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg [&>button]:size-12">
          <SheetHeader>
            <SheetTitle>
              {item?.name.es ?? menu?.name.es ?? "Elegir plato"}
            </SheetTitle>
            <SheetDescription>
              Revisa variantes, extras y alérgenos antes de añadir.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-6">
            {item ? (
              <PlatoForm key={`${item.id}:${editing?.index ?? "nuevo"}`} item={item} initial={editing?.index !== undefined ? lines[editing.index] : undefined} onAdd={add} />
            ) : menu ? (
              <MenuForm key={menu.id} menu={menu} carta={carta} onAdd={add} />
            ) : null}
          </div>
        </SheetContent>
      </Sheet>
      {lines.length > 0 ? (
        <div className="sticky bottom-3 z-20 col-span-full rounded-xl border bg-popover p-2 shadow-float lg:hidden">
          <Button
            type="button"
            variant="outline"
            className="h-12 w-full"
            onClick={() => {
              draftRef.current?.focus({ preventScroll: true })
              draftRef.current?.scrollIntoView({
                behavior: "auto",
                block: "start",
              })
            }}
          >
            Revisar pedido · {lines.length} líneas · {euros(priced.totalCents)}
          </Button>
        </div>
      ) : null}
    </div>
  )
}
