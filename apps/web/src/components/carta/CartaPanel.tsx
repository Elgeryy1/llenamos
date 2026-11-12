"use client"
import { useRef, useState } from "react"
import { type DailyMenuEditable, type MenuCategory, type MenuItemEditable } from "@llenamos/core"
import { PlusIcon, ForkKnifeIcon } from "@phosphor-icons/react"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { SelectField } from "@/components/common/form-fields"
import { EmptyState } from "@/components/common/empty-state"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { errorText, saveCarta } from "@/lib/carta/callables"
import { categoryDraft, itemDraft, menuDraft, euros } from "@/lib/carta/forms"
import { useCatalog, useStations } from "@/lib/carta/hooks"
import { uploadPhoto, validatePhoto } from "@/lib/carta/photos"
import { ItemEditor } from "./ItemEditor"
import { DailyMenuEditor } from "./DailyMenuEditor"
import { NumberField, Toggle, Translation } from "./Fields"
import { ErrorNotice } from "./ErrorNotice"
import { Photo } from "./Photo"

type Draft =
  | { kind: "category"; id: string | null; value: MenuCategory }
  | { kind: "item"; id: string | null; value: MenuItemEditable }
  | { kind: "menu"; id: string | null; value: DailyMenuEditable }
export function CartaPanel() {
  return (
    <RequirePermission permission="carta.editar" what="la carta">
      <RequireModule module="floor">
        <Carta />
      </RequireModule>
    </RequirePermission>
  )
}
function Carta() {
  const { restaurant, location } = usePanel()
  const data = useCatalog(restaurant.id, location?.id ?? null)
  const stations = useStations(location ? `restaurants/${restaurant.id}/locations/${location.id}` : null)
  const [tab, setTab] = useState("items")
  const [draft, setDraft] = useState<Draft | null>(null)
  const [pending, setPending] = useState(false)
  const lock = useRef(false)
  const [message, setMessage] = useState("")
  const [error, setError] = useState("")
  const [photo, setPhoto] = useState<File | null>(null)
  const categories =
    data.categories.status === "ready" ? data.categories.data.toSorted((a, b) => a.sortOrder - b.sortOrder) : []
  const items = data.items.status === "ready" ? data.items.data.toSorted((a, b) => a.sortOrder - b.sortOrder) : []
  const menus = data.menus.status === "ready" ? data.menus.data.toSorted((a, b) => a.sortOrder - b.sortOrder) : []
  const stationList = stations.status === "ready" ? stations.data : []
  const readError = [data.categories, data.items, data.menus].find((s) => s.status === "error")
  const scope = { restaurantId: restaurant.id, locationId: location?.id ?? "" }
  function edit(next: Draft | null) {
    setDraft(next)
    setError("")
    setMessage("")
    setPhoto(null)
  }
  async function run(action: () => Promise<unknown>, success: string) {
    if (lock.current) return
    lock.current = true
    setPending(true)
    setError("")
    setMessage("")
    try {
      await action()
      setMessage(success)
    } catch (e) {
      setError(errorText(e))
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  async function save() {
    if (!draft || !location) return
    await run(async () => {
      if (draft.kind === "category")
        await saveCarta("guardarCategoriaCarta", { ...scope, categoryId: draft.id, category: draft.value })
      if (draft.kind === "menu")
        await saveCarta("guardarMenuDia", { ...scope, dailyMenuId: draft.id, menu: draft.value })
      if (draft.kind === "item") {
        const result = await saveCarta("guardarPlato", { ...scope, itemId: draft.id, item: draft.value })
        // El id confirmado se conserva si falla la subida, para no crear el plato dos veces.
        setDraft({ ...draft, id: result.itemId })
        if (photo) {
          const photoPath = await uploadPhoto(scope.restaurantId, scope.locationId, result.itemId, photo)
          await saveCarta("guardarPlato", {
            ...scope,
            itemId: result.itemId,
            item: { ...draft.value, photoPath },
          })
        }
      }
      setDraft(null)
      setPhoto(null)
    }, "Guardado. El servidor ha confirmado los cambios.")
  }
  if (!location)
    return (
      <EmptyState title="Elige un local" description="Cada local tiene su propia carta." icon={<ForkKnifeIcon />} />
    )
  return (
    <>
      <PageHeading
        title="Una carta a punto para el servicio"
        eyebrow={location.name}
        description="Precios con IVA, fotos y alérgenos. Las traducciones vacías muestran el castellano."
        actions={
          <Button size="lg" onClick={() => edit({ kind: "item", id: null, value: itemDraft(categories[0]?.id) })}>
            <PlusIcon aria-hidden /> Nuevo plato
          </Button>
        }
      />
      <SummaryStrip
        label="Carta del local"
        items={[
          { label: "Platos", value: data.items.status === "ready" ? items.length : "…" },
          {
            label: "Agotados",
            value: data.items.status === "ready" ? items.filter((i) => i.soldOut).length : "…",
            tone: "warning",
          },
          { label: "Menús del día", value: data.menus.status === "ready" ? menus.length : "…" },
        ]}
      />
      <div className="my-5 flex flex-wrap items-center gap-3">
        <SelectField label="Mostrar" value={tab} onChange={(e) => setTab(e.target.value)}>
          <option value="items">Platos</option>
          <option value="categories">Categorías</option>
          <option value="menus">Menús del día</option>
        </SelectField>
        <Button variant="outline" onClick={() => edit({ kind: "category", id: null, value: categoryDraft() })}>
          Nueva categoría
        </Button>
        <Button variant="outline" onClick={() => edit({ kind: "menu", id: null, value: menuDraft() })}>
          Nuevo menú del día
        </Button>
      </div>
      {readError?.status === "error" && <ErrorNotice message={errorText(readError.error)} />}
      {error && <ErrorNotice message={error} />}
      {message && (
        <p role="status" className="my-4 rounded-xl border border-success/40 bg-success/10 p-4 text-sm text-success">
          {message}
        </p>
      )}
      {draft ? (
        <form
          key={`${draft.kind}:${draft.id ?? "new"}`}
          className="superficie my-5 space-y-6 p-5 sm:p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <h2 className="text-lg font-semibold">
            {draft.id ? "Editar" : "Crear"}{" "}
            {draft.kind === "item" ? "plato" : draft.kind === "menu" ? "menú del día" : "categoría"}
          </h2>
          <fieldset disabled={pending} className="space-y-6">
            {draft.kind === "category" && (
              <>
                <Translation
                  label="Nombre de la categoría"
                  maxLength={60}
                  value={draft.value.name}
                  onChange={(name) => setDraft({ ...draft, value: { ...draft.value, name } })}
                />
                <Translation
                  label="Descripción"
                  maxLength={200}
                  value={draft.value.description}
                  onChange={(description) => setDraft({ ...draft, value: { ...draft.value, description } })}
                />
                <NumberField
                  label="Posición"
                  value={draft.value.sortOrder}
                  max={10000}
                  onChange={(sortOrder) => setDraft({ ...draft, value: { ...draft.value, sortOrder } })}
                />
                <Toggle
                  label="Visible"
                  checked={draft.value.active}
                  onChange={(active) => setDraft({ ...draft, value: { ...draft.value, active } })}
                />
              </>
            )}
            {draft.kind === "item" && (
              <>
                <ItemEditor
                  value={draft.value}
                  onChange={(value) => setDraft({ ...draft, value })}
                  categories={categories}
                  stations={stationList}
                />
                <label className="grid gap-2 text-sm">
                  Foto del plato
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    onChange={(e) => {
                      const f = e.target.files?.[0] ?? null
                      try {
                        if (f) validatePhoto(f)
                        setPhoto(f)
                        setError("")
                      } catch (err) {
                        setPhoto(null)
                        e.target.value = ""
                        setError(errorText(err))
                      }
                    }}
                  />
                  <span className="text-xs text-muted-foreground">
                    Hasta 5 MiB. Primero se guarda el plato y después su foto.
                  </span>
                </label>
                {draft.value.photoPath && (
                  <>
                    <Photo path={draft.value.photoPath} alt={draft.value.name.es} />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setDraft({ ...draft, value: { ...draft.value, photoPath: null } })}
                    >
                      Retirar foto de la carta
                    </Button>
                  </>
                )}
              </>
            )}
            {draft.kind === "menu" && (
              <DailyMenuEditor value={draft.value} onChange={(value) => setDraft({ ...draft, value })} items={items} />
            )}
          </fieldset>
          <div className="flex gap-3">
            <Button disabled={pending} type="submit">
              {pending ? "Guardando…" : "Guardar cambios"}
            </Button>
            <Button disabled={pending} type="button" variant="outline" onClick={() => edit(null)}>
              Cerrar editor
            </Button>
          </div>
        </form>
      ) : null}
      <section className="superficie divide-y overflow-hidden" aria-label="Contenido de la carta">
        {tab === "items" &&
          items.map((i) => (
            <article key={i.id} className="flex flex-wrap items-center gap-4 p-5">
              <div className="min-w-40 flex-1">
                <h2 className="font-medium">{i.name.es}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {categories.find((c) => c.id === i.categoryId)?.name.es} ·{" "}
                  <span className="cifra">{euros(i.priceCents)}</span> ·{" "}
                  {i.active ? (i.soldOut ? "Agotado" : "Disponible") : "Retirado"}
                </p>
              </div>
              {i.variants.map((v) => (
                <Button
                  key={v.id}
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(
                      () =>
                        saveCarta("marcarAgotado", {
                          ...scope,
                          itemId: i.id,
                          variantId: v.id,
                          soldOut: !v.soldOut,
                        }),
                      "Variante actualizada.",
                    )
                  }
                >
                  {v.name.es} · {v.soldOut ? "Reponer" : "Agotar"}
                </Button>
              ))}
              <Button variant="outline" onClick={() => edit({ kind: "item", id: i.id, value: i })}>
                Editar {i.name.es}
              </Button>
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() =>
                  void run(
                    () => saveCarta("marcarAgotado", { ...scope, itemId: i.id, soldOut: !i.soldOut }),
                    "Disponibilidad actualizada.",
                  )
                }
              >
                {i.soldOut ? "Disponible" : "Marcar agotado"}
              </Button>
            </article>
          ))}
        {tab === "categories" &&
          categories.map((c, index) => (
            <article key={c.id} className="flex flex-wrap items-center gap-3 p-5">
              <div className="flex-1">
                <h2>{c.name.es}</h2>
                <p className="text-sm text-muted-foreground">{c.active ? "Visible" : "Oculta"}</p>
              </div>
              <Button variant="outline" onClick={() => edit({ kind: "category", id: c.id, value: c })}>
                Editar
              </Button>
              <Button
                variant="ghost"
                disabled={index === 0 || pending}
                onClick={() =>
                  void run(() => {
                    const order = [...categories]
                    ;[order[index - 1], order[index]] = [order[index], order[index - 1]]
                    return saveCarta("ordenarCarta", {
                      ...scope,
                      categories: order.map((x, sortOrder) => ({ id: x.id, sortOrder })),
                    })
                  }, "Orden actualizado.")
                }
              >
                Subir
              </Button>
            </article>
          ))}
        {tab === "menus" &&
          menus.map((m) => (
            <article key={m.id} className="flex items-center gap-4 p-5">
              <div className="flex-1">
                <h2>{m.name.es}</h2>
                <p className="text-sm text-muted-foreground">
                  {euros(m.priceCents)} · {m.from} a {m.to} · {m.active ? "Visible" : "Retirado"}
                </p>
              </div>
              <Button variant="outline" onClick={() => edit({ kind: "menu", id: m.id, value: m })}>
                Editar
              </Button>
            </article>
          ))}
        {(tab === "items" ? items.length : tab === "menus" ? menus.length : categories.length) === 0 && (
          <div className="px-5 py-10">
            <p className="font-medium">La carta espera sus primeros sabores</p>
            <p className="mt-2 text-sm text-muted-foreground">
              Crea una categoría y añade sus platos. Solo aparecerán aquí los datos confirmados por el servidor.
            </p>
          </div>
        )}
      </section>
    </>
  )
}
