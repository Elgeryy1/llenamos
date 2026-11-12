"use client"

import type { ImportRowError } from "@llenamos/core"
import { DownloadSimpleIcon, FileCsvIcon, UploadSimpleIcon } from "@phosphor-icons/react"
import { useMemo, useRef, useState, type DragEvent } from "react"
import { toast } from "sonner"
import { dataTableColumns, DataTable, type DataTableColumn } from "@/components/common/data-table"
import { Notice } from "@/components/common/notice"
import { SummaryStrip } from "@/components/common/summary-strip"
import { Tag } from "@/components/common/tag"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { RequireReservations } from "@/components/reservas/RequireReservations"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"
import { llamarCore } from "@/lib/data/callables"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import {
  IMPORT_FIELD_LABEL,
  importBatches,
  ImportFileError,
  readImportFile,
  remapErrors,
  REQUIRED_FIELDS,
  SAMPLE_CSV,
  type ImportPreview,
  type PreviewRow,
} from "@/lib/reservas/importar"

export function ImportarView() {
  return (
    <RequirePermission permission="reservas.importar" what="la importación de reservas">
      <RequireReservations>
        <Importar />
      </RequireReservations>
    </RequirePermission>
  )
}

type RowOutcome = { kind: "created" } | { kind: "checked" } | { kind: "errors"; errors: ImportRowError[] }

function Importar() {
  const { restaurant, location } = usePanel()
  const input = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [preview, setPreview] = useState<ImportPreview | null>(null)
  const [outcomes, setOutcomes] = useState<Map<number, RowOutcome>>(new Map())
  const [onlyErrors, setOnlyErrors] = useState(false)
  const [visibleRows, setVisibleRows] = useState(50)
  const [busy, setBusy] = useState<"check" | "import" | null>(null)
  const [serverError, setServerError] = useState<ErrorInfo | null>(null)
  const [created, setCreated] = useState<number | null>(null)
  const [dragging, setDragging] = useState(false)

  async function load(file: File) {
    setVisibleRows(50)
    setFileError(null)
    setServerError(null)
    setCreated(null)
    setOutcomes(new Map())
    setFileName(file.name)
    if (file.size > 5 * 1024 * 1024) {
      setPreview(null)
      setFileError("El archivo pesa más de 5 MB. Divide la hoja en varias.")
      return
    }
    try {
      setPreview(await readImportFile(file.name, await file.arrayBuffer()))
    } catch (e) {
      setPreview(null)
      setFileError(e instanceof ImportFileError ? e.message : "No se ha podido leer el archivo.")
    }
  }

  async function send(dryRun: boolean) {
    if (!preview || !location) return
    setBusy(dryRun ? "check" : "import")
    setServerError(null)
    const next = new Map(outcomes)
    let total = 0
    try {
      for (const batch of importBatches(preview.rows.filter((r) => outcomes.get(r.index)?.kind !== "created"))) {
        const out = await llamarCore("importarReservas", { restaurantId: restaurant.id, locationId: location.id, rows: batch.rows, dryRun })
        const errors = remapErrors(out.errors, batch.indexes)
        for (const index of batch.indexes) {
          const own = errors.filter((e) => e.row === index)
          next.set(index, own.length > 0 ? { kind: "errors", errors: own } : { kind: dryRun ? "checked" : "created" })
        }
        total += out.created
      }
      if (!dryRun) {
        setCreated(total)
        toast.success(`${total} ${total === 1 ? "reserva importada" : "reservas importadas"}`)
      }
    } catch (error) {
      setServerError(describeError(error))
    } finally {
      setOutcomes(next)
      setBusy(null)
    }
  }

  const rows = useMemo(() => {
    if (!preview) return []
    return preview.rows.filter((r) => !onlyErrors || r.errors.length > 0 || outcomes.get(r.index)?.kind === "errors")
  }, [preview, onlyErrors, outcomes])

  const pendingRows = preview ? preview.rows.filter((r) => r.value !== null && outcomes.get(r.index)?.kind !== "created") : []
  const serverErrors = [...outcomes.values()].filter((o) => o.kind === "errors").length
  const blocked = !preview || preview.missingFields.length > 0 || pendingRows.length === 0

  const columns = useMemo<DataTableColumn<PreviewRow>[]>(() => {
    const col = dataTableColumns<PreviewRow>()
    const text = (field: keyof PreviewRow["raw"]) => (r: PreviewRow) => r.raw[field] ?? ""
    return [
      col.accessor("line", { header: "Línea", cell: (c) => <span className="cifra text-muted-foreground">{c.getValue()}</span> }),
      col.accessor(text("guestName"), { id: "guestName", header: "Nombre", cell: (c) => <span className="font-medium">{c.getValue()}</span> }),
      col.accessor((r) => r.value?.phone ?? r.raw.phone ?? "", { id: "phone", header: "Teléfono", cell: (c) => <span className="cifra whitespace-nowrap">{c.getValue()}</span> }),
      col.accessor((r) => r.value?.date ?? r.raw.date ?? "", { id: "date", header: "Fecha", cell: (c) => <span className="cifra whitespace-nowrap">{c.getValue()}</span> }),
      col.accessor((r) => r.value?.time ?? r.raw.time ?? "", { id: "time", header: "Hora", cell: (c) => <span className="cifra">{c.getValue()}</span> }),
      col.accessor(text("partySize"), { id: "partySize", header: "Pers.", cell: (c) => <span className="cifra">{c.getValue()}</span> }),
      col.accessor((r) => r.value?.tables.join(" + ") ?? r.raw.tables ?? "", { id: "tables", header: "Mesa", cell: (c) => <span className="cifra">{c.getValue()}</span> }),
      col.display({
        id: "result",
        header: "Resultado",
        cell: (c) => <RowResult row={c.row.original} outcome={outcomes.get(c.row.original.index)} />,
      }),
    ]
  }, [outcomes])

  function onDrop(e: DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) void load(file)
  }

  return (
    <>
      <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="mb-1.5 text-[13px] text-muted-foreground sm:text-sm">Importar reservas · {location?.name ?? "Elige un local"}</p>
          <h1 className="text-2xl font-semibold tracking-tight text-balance sm:text-[32px]">{created !== null ? `${created} ${created === 1 ? "reserva ya está aquí" : "reservas ya están aquí"}` : "Tus reservas, también aquí"}</h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">Trae las que ya tenías en Excel o CSV. Revisa la hoja y comprueba mesas y horas antes de importarlas.</p>
        </div>
        <Button variant="outline" size="lg" className="bg-card shadow-soft pointer-coarse:min-h-11 max-sm:w-full" asChild>
          <a href={`data:text/csv;charset=utf-8,${encodeURIComponent(`﻿${SAMPLE_CSV}`)}`} download="reservas-ejemplo.csv"><DownloadSimpleIcon aria-hidden /> CSV de ejemplo</a>
        </Button>
      </header>
      <ol aria-label="Pasos de la importación" className="superficie mb-6 grid grid-cols-3 divide-x overflow-hidden max-sm:rounded-xl">
        {["Elegir archivo", "Revisar filas", "Importar"].map((label, i) => {
          const current = created !== null ? 2 : preview ? 1 : 0
          return <li key={label} aria-current={i === current ? "step" : undefined} className={cn("flex flex-col items-start gap-2 px-3 py-3 text-xs sm:flex-row sm:items-center sm:px-5 sm:text-sm", i === current ? "bg-surface-raised text-foreground" : "text-muted-foreground")}><span className={cn("cifra flex size-6 shrink-0 items-center justify-center rounded-md border", i === current && "border-primary/30 text-warning")}>{i + 1}</span>{label}</li>
        })}
      </ol>

      <div
        onDragOver={(e) => {
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={cn("superficie mb-6 flex min-w-0 flex-col items-center gap-3 border-dashed p-5 text-center transition-colors sm:p-8", dragging && "border-primary bg-primary/5")}
      >
        <span className="flex size-12 items-center justify-center rounded-xl border bg-surface-sunken text-warning"><FileCsvIcon size={24} aria-hidden /></span>
        <p className="text-sm text-soft-foreground">
          {fileName ? <span className="font-medium break-all text-foreground">{fileName}</span> : "Arrastra aquí el archivo o elígelo."} La primera fila lleva los nombres de las columnas.
        </p>
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Obligatorias: {REQUIRED_FIELDS.map((f) => IMPORT_FIELD_LABEL[f].toLowerCase()).join(", ")}. Opcionales: correo, duración, estado, idioma, notas y mesa. Fechas como 9/11/2026, horas como 13:30. De un Excel se lee la primera hoja.
        </p>
        <input
          ref={input}
          type="file"
          accept=".csv,text/csv,.txt,.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          className="sr-only"
          aria-label="Archivo de reservas (Excel o CSV)"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) void load(file)
            e.target.value = ""
          }}
        />
        <Button className="shadow-soft max-sm:w-full" variant={preview ? "outline" : "default"} size="lg" onClick={() => input.current?.click()} disabled={busy !== null}>
          <UploadSimpleIcon aria-hidden /> {preview ? "Elegir otro archivo" : "Elegir archivo"}
        </Button>
      </div>

      {fileError ? (
        <Notice tone="error" className="mb-6" title="No se puede usar este archivo">
          {fileError}
        </Notice>
      ) : null}

      {preview ? (
        <>
          {preview.problems.map((p) => (
            <Notice key={p} tone="warning" className="mb-4">
              {p}
            </Notice>
          ))}

          <SummaryStrip className="mb-6" label="Resumen de la hoja" items={[
            { label: "Filas en la hoja", value: preview.rows.length },
            { label: "Listas para importar", value: pendingRows.length, tone: pendingRows.length ? "success" : undefined },
            { label: "Errores en la hoja", value: preview.invalid, tone: preview.invalid ? "destructive" : undefined, hint: preview.invalid ? "no se envían" : undefined },
            ...(outcomes.size > 0 ? [{ label: "Rechazadas al comprobar", value: serverErrors, tone: serverErrors ? "warning" as const : undefined }] : []),
          ]} />
          <details className="superficie mb-6 px-4">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm text-soft-foreground">Columnas reconocidas en la hoja</summary>
            <div className="flex flex-wrap gap-1.5 border-t py-3">
              {preview.columns.map((c, i) => <Tag key={`${c.header}-${i}`} tone={c.field ? "neutro" : "aviso"} title={c.field ? undefined : "Esta columna no se reconoce y se ignora"}>{c.header || "(sin nombre)"} → {c.field ? IMPORT_FIELD_LABEL[c.field].toLowerCase() : "se ignora"}</Tag>)}
            </div>
          </details>

          {created !== null ? (
            <Notice tone="success" className="mb-4" title={`${created} ${created === 1 ? "reserva creada" : "reservas creadas"}`}>
              Ya están en Reservas. Las filas con error no se han importado: corrígelas y sube una hoja solo con esas filas, para no repetir las que ya se han creado.
            </Notice>
          ) : null}
          {serverError ? (
            <Notice tone="error" className="mb-4" title="El servidor no ha podido importar" detail={serverError.code}>
              {serverError.message}
            </Notice>
          ) : null}

          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <Field orientation="horizontal" className="min-h-11 w-auto">
              <Checkbox id="solo-errores" checked={onlyErrors} onCheckedChange={(v) => setOnlyErrors(v === true)} />
              <FieldLabel htmlFor="solo-errores" className="min-h-11 items-center font-normal">
                Ver solo las filas con errores
              </FieldLabel>
            </Field>
            <div className="flex w-full flex-wrap gap-2 sm:w-auto">
              <Button className="bg-card shadow-soft max-sm:min-h-11 max-sm:w-full" variant="outline" size="lg" disabled={blocked || busy !== null} onClick={() => void send(true)}>
                {busy === "check" ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
                {busy === "check" ? "Comprobando…" : "Comprobar mesas y horas"}
              </Button>
              <Button className="shadow-soft max-sm:min-h-11 max-sm:w-full" size="lg" disabled={blocked || busy !== null} onClick={() => void send(false)}>
                {busy === "import" ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
                {busy === "import" ? "Importando…" : `Importar ${pendingRows.length} ${pendingRows.length === 1 ? "reserva" : "reservas"}`}
              </Button>
            </div>
          </div>

          <div className="superficie hidden min-w-0 p-3 sm:block [&_table]:bg-transparent">
            <DataTable
              columns={columns}
              data={rows}
              getRowId={(r) => String(r.index)}
              caption="Vista previa de la importación"
              rowClassName={(r) => (outcomes.get(r.index)?.kind === "created" ? "opacity-60" : undefined)}
              empty={onlyErrors ? "Ninguna fila con errores." : "El archivo no tiene filas."}
              pageSize={50}
            />
          </div>
          <section className="superficie overflow-hidden rounded-xl sm:hidden" aria-label="Vista previa de la importación">
            <h2 className="border-b px-4 py-3 text-base font-semibold">Revisa tus reservas</h2>
            {rows.length === 0 ? <p className="p-4 text-sm text-muted-foreground">{onlyErrors ? "Ninguna fila con errores." : "El archivo no tiene filas."}</p> : <ul className="divide-y">
              {rows.slice(0, visibleRows).map((r) => <li key={r.index} className={cn("flex flex-col gap-2 p-4 [overflow-wrap:anywhere]", outcomes.get(r.index)?.kind === "created" && "opacity-60")}>
                <p className="text-xs text-muted-foreground">Línea <span className="cifra">{r.line}</span></p>
                <p className="text-[15px] font-medium break-words">{r.raw.guestName || "Sin nombre"}</p>
                <p className="cifra text-xs text-soft-foreground">{r.value?.phone ?? r.raw.phone ?? "Sin teléfono"}</p>
                <p className="text-sm text-soft-foreground"><span className="cifra">{r.value?.date ?? r.raw.date} · {r.value?.time ?? r.raw.time}</span></p>
                <p className="text-xs text-muted-foreground">{r.raw.partySize || "Sin número de"} personas{r.raw.tables ? ` · Mesa ${r.raw.tables}` : " · Sin mesa indicada"}</p>
                <RowResult row={r} outcome={outcomes.get(r.index)} />
              </li>)}
            </ul>}
            {rows.length > visibleRows ? <div className="border-t p-3"><Button variant="outline" className="w-full" onClick={() => setVisibleRows((n) => n + 50)}>Ver más filas</Button></div> : null}
          </section>
        </>
      ) : null}
    </>
  )
}

function RowResult({ row, outcome }: { row: PreviewRow; outcome: RowOutcome | undefined }) {
  const errors = row.errors.length > 0 ? row.errors : outcome?.kind === "errors" ? outcome.errors : []
  if (errors.length > 0) {
    return (
      <ul className="flex flex-col gap-0.5 text-xs text-destructive">
        {errors.map((e, i) => (
          <li key={i}>
            {e.field && e.field in IMPORT_FIELD_LABEL ? `${IMPORT_FIELD_LABEL[e.field as keyof typeof IMPORT_FIELD_LABEL]}: ` : ""}
            {e.message}
          </li>
        ))}
      </ul>
    )
  }
  const label = outcome?.kind === "created" ? "Creada" : outcome?.kind === "checked" ? "Hay sitio" : "Lista"
  return <span className={cn("inline-flex items-center gap-2 text-xs", outcome ? "text-success" : "text-muted-foreground")}><span aria-hidden className={cn("size-2 shrink-0 rounded-full border", outcome ? "border-success bg-success" : "border-muted-foreground")} />{label}</span>
}
