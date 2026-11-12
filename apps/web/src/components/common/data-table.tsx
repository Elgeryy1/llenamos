"use client"

/**
 * Tabla de datos densa con TanStack Table v9 y la Table de shadcn, sacada de la tabla
 * del bloque dashboard-01 (sin arrastrar filas): orden por columnas, paginación y fila
 * vacía. Para la lista de clientes, el equipo o cualquier listado largo.
 *
 *   const col = dataTableColumns<Cliente>()
 *   const columns = [
 *     col.accessor("name", { header: ({ column }) => <DataTableColumnHeader column={column} title="Cliente" /> }),
 *     col.accessor("visits", { header: "Visitas", cell: (c) => <span className="cifra">{c.getValue()}</span> }),
 *   ]
 *   <DataTable columns={columns} data={clientes} getRowId={(c) => c.id} onRowClick={abrirFicha} />
 */
import {
  createColumnHelper,
  createPaginatedRowModel,
  createSortedRowModel,
  FlexRender,
  rowPaginationFeature,
  rowSortingFeature,
  tableFeatures,
  useTable,
  type CellData,
  type Column,
  type ColumnDef,
  type RowData,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowDownIcon, ArrowUpIcon, ArrowsDownUpIcon, CaretLeftIcon, CaretRightIcon } from "@phosphor-icons/react"
import { useState, type ReactNode } from "react"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/cn"

export const dataTableFeatures = tableFeatures({
  rowSortingFeature,
  rowPaginationFeature,
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
})

type Features = typeof dataTableFeatures

/** Ayudante para definir columnas con los tipos ya puestos. */
export function dataTableColumns<TData extends RowData>() {
  return createColumnHelper<Features, TData>()
}

export type DataTableColumn<TData extends RowData> = ColumnDef<Features, TData, any> // eslint-disable-line @typescript-eslint/no-explicit-any -- cada columna tiene su propio tipo de valor

/** Cabecera que ordena al pulsarla (asc, desc, sin orden) y lo anuncia con aria-sort. */
export function DataTableColumnHeader<TData extends RowData, TValue extends CellData>({
  column,
  title,
  className,
}: {
  column: Column<Features, TData, TValue>
  title: string
  className?: string
}) {
  if (!column.getCanSort()) return <span className={className}>{title}</span>
  const sorted = column.getIsSorted()
  const next = sorted === false ? "ascendente" : sorted === "asc" ? "descendente" : "sin orden"
  return (
    <Button
      variant="ghost"
      size="sm"
      className={cn("-ml-2 h-7 gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground", className)}
      onClick={column.getToggleSortingHandler()}
      aria-label={`${title}, ordenar ${next}`}
    >
      {title}
      {sorted === "asc" ? <ArrowUpIcon aria-hidden /> : sorted === "desc" ? <ArrowDownIcon aria-hidden /> : <ArrowsDownUpIcon aria-hidden className="opacity-50" />}
    </Button>
  )
}

export function DataTable<TData extends RowData>({
  columns,
  data,
  getRowId,
  onRowClick,
  rowLabel,
  empty = "No hay nada que enseñar.",
  pageSize = 25,
  initialSorting = [],
  rowClassName,
  caption,
  className,
}: {
  columns: DataTableColumn<TData>[]
  data: TData[]
  getRowId: (row: TData) => string
  /** Al pulsar la fila (abrir el detalle en un Sheet, por ejemplo). Con teclado: Intro. */
  onRowClick?: (row: TData) => void
  /** Nombre accesible de la fila cuando se puede pulsar («Abrir la ficha de Clara Ibáñez»). */
  rowLabel?: (row: TData) => string
  empty?: ReactNode
  pageSize?: number
  initialSorting?: SortingState
  rowClassName?: (row: TData) => string | undefined
  /** Título de la tabla para lectores de pantalla. */
  caption?: string
  className?: string
}) {
  const [sorting, setSorting] = useState<SortingState>(initialSorting)
  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize })

  const table = useTable({
    features: dataTableFeatures,
    data,
    columns,
    state: { sorting, pagination },
    getRowId: (row) => getRowId(row),
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
  })

  const rows = table.getRowModel().rows
  const pages = table.getPageCount()

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      {/* Las tablas anchas se desplazan dentro de su caja, no la página. */}
      <div className="overflow-x-auto rounded-xl border">
        <Table>
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader className="bg-card">
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <TableHead
                      key={header.id}
                      colSpan={header.colSpan}
                      aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined}
                      className="h-9 text-xs font-medium text-muted-foreground"
                    >
                      {header.isPlaceholder ? null : <FlexRender header={header} />}
                    </TableHead>
                  )
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((row) => (
                <TableRow
                  key={row.id}
                  tabIndex={onRowClick ? 0 : undefined}
                  aria-label={onRowClick && rowLabel ? rowLabel(row.original) : undefined}
                  onClick={onRowClick ? () => onRowClick(row.original) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          if (e.key === "Enter") onRowClick(row.original)
                        }
                      : undefined
                  }
                  className={cn("text-[13px]", onRowClick && "cursor-pointer", rowClassName?.(row.original))}
                >
                  {row.getAllCells().map((cell) => (
                    <TableCell key={cell.id} className="py-2.5">
                      <FlexRender cell={cell} />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-end gap-2 text-sm">
          <span className="cifra text-xs text-muted-foreground">
            Página {pagination.pageIndex + 1} de {pages}
          </span>
          <Button variant="outline" size="icon" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()} aria-label="Página anterior">
            <CaretLeftIcon aria-hidden />
          </Button>
          <Button variant="outline" size="icon" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()} aria-label="Página siguiente">
            <CaretRightIcon aria-hidden />
          </Button>
        </div>
      ) : null}
    </div>
  )
}
