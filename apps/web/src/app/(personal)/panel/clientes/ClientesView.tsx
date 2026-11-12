"use client"

import { customerIdFor, tryNormalizePhone } from "@llenamos/core"
import { CaretRightIcon, MagnifyingGlassIcon, UsersThreeIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { dataTableColumns, DataTable, DataTableColumnHeader, type DataTableColumn } from "@/components/common/data-table"
import { CustomerBadges } from "@/components/common/customer-badges"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Button } from "@/components/ui/button"
import { GuestAvatar } from "@/components/reservas/Huesped"
import { EmptyState } from "@/components/common/empty-state"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { CustomerSheet } from "@/components/reservas/CustomerSheet"
import { RequireReservations } from "@/components/reservas/RequireReservations"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Skeleton } from "@/components/ui/skeleton"
import { CUSTOMERS_LIMIT, useCustomer, useCustomers, type CustomerDoc } from "@/lib/data/reservas"
import { fold } from "@/lib/reservas/estados"
import { prettyPhone, shortDate } from "@/lib/reservas/formato"
import { matchesCustomer } from "@/lib/reservas/clientes"

export function ClientesView() {
  return (
    <RequirePermission permission="clientes.ver" what="los clientes">
      <RequireReservations>
        <Clientes />
      </RequireReservations>
    </RequirePermission>
  )
}

function Clientes() {
  const { restaurant } = usePanel()
  const tz = restaurant.timezone
  const customers = useCustomers(restaurant.id)
  const [search, setSearch] = useState("")
  const [visible, setVisible] = useState(25)
  const [openId, setOpenId] = useState<string | null>(null)

  // Un teléfono completo se busca directamente por su ficha, aunque no esté entre las cargadas.
  const phone = tryNormalizePhone(search)
  const direct = useCustomer(restaurant.id, phone ? customerIdFor(restaurant.id, phone) : null)

  const list = useMemo(() => {
    if (customers.status !== "ready") return []
    const found = customers.data.filter((c) => matchesCustomer(c, search))
    const extra = direct.status === "ready" ? direct.data : null
    return extra && !found.some((c) => c.id === extra.id) ? [extra, ...found] : found
  }, [customers, search, direct])

  const opened = (customers.status === "ready" ? customers.data.find((c) => c.id === openId) : null) ?? (direct.status === "ready" && direct.data?.id === openId ? direct.data : null)

  const columns = useMemo<DataTableColumn<CustomerDoc>[]>(() => {
    const col = dataTableColumns<CustomerDoc>()
    return [
      col.accessor((c) => fold(c.name), {
        id: "name",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Cliente" />,
        cell: (c) => {
          const x = c.row.original
          return (
            <span className="flex items-center gap-3 py-1">
              <GuestAvatar name={x.name} />
              <span className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[15px] font-medium">{x.name}</span>
                <CustomerBadges customer={x} />
              </span>
            </span>
          )
        },
      }),
      col.accessor("phone", { header: "Teléfono", enableSorting: false, cell: (c) => <span className="cifra whitespace-nowrap text-soft-foreground">{prettyPhone(c.getValue())}</span> }),
      col.accessor("visits", { header: ({ column }) => <DataTableColumnHeader column={column} title="Visitas" />, cell: (c) => <span className="cifra">{c.getValue()}</span> }),
      col.accessor("noShows", {
        header: ({ column }) => <DataTableColumnHeader column={column} title="No vino" />,
        cell: (c) => <span className={`cifra ${c.getValue() > 0 ? "text-warning" : ""}`}>{c.getValue()}</span>,
      }),
      col.accessor("cancellations", { header: ({ column }) => <DataTableColumnHeader column={column} title="Canceló" />, cell: (c) => <span className="cifra">{c.getValue()}</span> }),
      col.accessor((c) => c.lastVisitAt ?? 0, {
        id: "lastVisitAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Última visita" />,
        cell: (c) => <span className="cifra whitespace-nowrap text-muted-foreground">{c.getValue() ? shortDate(c.getValue(), tz) : "nunca"}</span>,
      }),
    ]
  }, [tz])

  const total = customers.status === "ready" ? customers.data.length : 0
  return (
    <>
      <header className="mb-6">
        <p className="mb-1.5 text-[13px] text-muted-foreground sm:text-sm">Clientes · {restaurant.name}</p>
        <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[32px]">
          {customers.status === "ready" ? `${total} ${total === 1 ? "cliente con su historia" : "clientes con su historia"}` : "Cada cliente, su historia"}
        </h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Sus visitas, lo que les gusta y lo que hay que recordar para recibirles bien. Cada reserva con teléfono crea su ficha.</p>
      </header>
      {customers.status === "ready" && total > 0 ? (
        <SummaryStrip label="Resumen de clientes" className="mb-6" items={[
          { label: "Clientes", value: total, hint: "fichas cargadas" },
          { label: "Habituales", value: customers.data.filter((c) => c.tags.some((t) => t.toLowerCase() === "habitual")).length, tone: "success" },
          { label: "Con alergias", value: customers.data.filter((c) => c.allergies).length, hint: "para tener en cuenta", tone: "destructive" },
        ]} />
      ) : null}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-base font-semibold">Agenda de clientes</h2>
        <InputGroup className="w-full bg-card shadow-soft sm:max-w-xs">
          <InputGroupAddon><MagnifyingGlassIcon aria-hidden /></InputGroupAddon>
          <InputGroupInput type="search" aria-label="Buscar cliente" placeholder="Nombre o teléfono" value={search} onChange={(e) => { setSearch(e.target.value); setVisible(25) }} />
        </InputGroup>
      </div>
      {search ? <p role="status" className="mb-3 text-sm text-muted-foreground">{list.length} {list.length === 1 ? "cliente encontrado" : "clientes encontrados"}</p> : null}

      {customers.status === "loading" ? (
        <LoadingBlock label="Cargando clientes…" className="flex flex-col gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </LoadingBlock>
      ) : customers.status === "error" ? (
        <LiveError title="No se han podido cargar los clientes" error={customers.error} />
      ) : total === 0 ? (
        <EmptyState icon={<UsersThreeIcon size={22} />} title="Aún no hay clientes" description="La primera reserva con teléfono crea su ficha." />
      ) : (
        <>
          {total >= CUSTOMERS_LIMIT ? (
            <Notice tone="info" className="mb-4">
              Se enseñan los {CUSTOMERS_LIMIT} primeros por nombre. Con un teléfono completo se encuentra cualquier ficha.
            </Notice>
          ) : null}
          <div className="superficie hidden min-w-0 p-3 sm:block [&_table]:bg-transparent [&_tr:hover]:bg-surface-raised">
            <DataTable
              columns={columns}
              data={list}
              getRowId={(c) => c.id}
              onRowClick={(c) => setOpenId(c.id)}
              rowLabel={(c) => `Abrir la ficha de ${c.name}`}
              caption="Clientes"
              initialSorting={[{ id: "name", desc: false }]}
              empty="Nadie con ese nombre o teléfono."
            />
          </div>
          <section className="superficie overflow-hidden rounded-xl sm:hidden" aria-label="Clientes">
            {list.length === 0 ? <p className="p-6 text-sm text-muted-foreground">Nadie con ese nombre o teléfono.</p> : (
              <ul className="divide-y">
                {list.slice(0, visible).map((c) => (
                  <li key={c.id}>
                    <button onClick={() => setOpenId(c.id)} aria-label={`Abrir la ficha de ${c.name}`} className="flex w-full items-start gap-3 p-4 text-left transition-colors hover:bg-surface-raised">
                      <GuestAvatar name={c.name} className="mt-1 shrink-0" />
                      <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <span className="text-[15px] font-medium break-words">{c.name}</span>
                        <span className="cifra text-xs text-muted-foreground">{prettyPhone(c.phone)}</span>
                        <CustomerBadges customer={c} />
                        <span className="text-xs text-muted-foreground"><span className="cifra text-soft-foreground">{c.visits}</span> visitas · {c.lastVisitAt ? shortDate(c.lastVisitAt, tz) : "Aún no ha venido"}</span>
                        {c.noShows || c.cancellations ? <span className="text-xs text-muted-foreground">No vino: {c.noShows} · Canceló: {c.cancellations}</span> : null}
                      </span>
                      <CaretRightIcon aria-hidden className="mt-2 shrink-0 text-muted-foreground" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {list.length > visible ? <div className="border-t p-3"><Button variant="outline" className="w-full" onClick={() => setVisible((n) => n + 25)}>Ver más clientes</Button></div> : null}
          </section>
        </>
      )}

      {opened ? <CustomerSheet customer={opened} open={openId !== null} onOpenChange={(o) => !o && setOpenId(null)} timezone={tz} /> : null}
    </>
  )
}
