"use client"
import Image from "next/image"
import { useRef, useState } from "react"
import type { CallableOutput } from "@llenamos/core"
import { Button } from "@/components/ui/button"
import { SelectField, TextField } from "@/components/common/form-fields"
import { usePanel } from "@/components/panel/PanelContext"
import { useSala } from "@/lib/data/hooks"
import { errorText, saveCarta } from "@/lib/carta/callables"
import { downloadQrPng, qrPlateSvg } from "@/lib/carta/qr"
import { Toggle } from "./Fields"
import { ErrorNotice } from "./ErrorNotice"

export function QrPanel() {
  const { restaurant, location } = usePanel()
  const sala = useSala(restaurant.id, location?.id ?? null)
  const [selected, setSelected] = useState<string[]>([])
  const [zone, setZone] = useState("")
  const [tokens, setTokens] = useState<CallableOutput<"regenerarQrMesa">["tokens"]>([])
  const [unavailable, setUnavailable] = useState<CallableOutput<"recuperarQrMesa">["unavailable"]>([])
  const [confirmed, setConfirmed] = useState(false)
  const [legacyLink, setLegacyLink] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState("")
  const [message, setMessage] = useState("")
  const lock = useRef(false)
  const scope = { restaurantId: restaurant.id, locationId: location?.id ?? "" }
  const tables = sala.status === "ready" ? sala.data.tables : []
  const areas = sala.status === "ready" ? sala.data.areas : []
  const tableName = (id: string) => tables.find((t) => t.id === id)?.name ?? id
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
      setPending(false)
      lock.current = false
    }
  }
  if (!location) return null
  return (
    <section className="superficie space-y-4 p-5">
      <h2 className="text-lg font-semibold">QR y etiquetas NFC de las mesas</h2>
      <p className="text-sm text-muted-foreground">
        Recupera el QR vigente para volver a imprimirlo. Las placas existentes siguen funcionando. El servidor
        conserva el secreto en una colección privada.
      </p>
      {error && <ErrorNotice message={error} />}
      {message && (
        <p role="status" className="text-sm text-success">
          {message}
        </p>
      )}
      <SelectField
        label="Zona de las mesas"
        value={zone || areas[0]?.id || ""}
        onChange={(e) => setZone(e.target.value)}
      >
        {areas.map((a) => (
          <option key={a.id} value={a.id}>
            {a.name}
          </option>
        ))}
      </SelectField>
      <div className="grid grid-cols-2 gap-x-4 sm:grid-cols-4">
        {tables
          .filter((t) => t.areaId === (zone || areas[0]?.id))
          .map((t) => (
            <Toggle
              key={t.id}
              label={`${t.name} · ${t.seats} plazas`}
              checked={selected.includes(t.id)}
              disabled={pending || (!selected.includes(t.id) && selected.length >= 8)}
              onChange={(checked) => {
                setSelected((x) => (checked ? [...x, t.id] : x.filter((id) => id !== t.id)))
                setTokens([])
                setUnavailable([])
              }}
            />
          ))}
      </div>
      <p className="text-sm">{selected.length === 1 ? "1 mesa elegida" : `${selected.length} mesas elegidas`}</p>
      <Button
        variant="outline"
        disabled={pending || !selected.length}
        onClick={() =>
          void run(async () => {
            const result = await saveCarta("recuperarQrMesa", { ...scope, tableIds: selected })
            setTokens(result.tokens)
            setUnavailable(result.unavailable)
            setMessage(
              `${result.tokens.length === 1 ? "1 código vigente recuperado" : `${result.tokens.length} códigos vigentes recuperados`}. Las placas conservan su validez.`,
            )
          })
        }
      >
        Recuperar QR vigente
      </Button>
      {unavailable.map((u) => (
        <div key={u.tableId} className="space-y-3 border-t pt-4 text-sm">
          <p>
            {tableName(u.tableId)} ·{" "}
            {u.reason === "legacy"
              ? "Solo se conserva el hash. Importa el enlace de la placa para recuperarla sin cambiarla."
              : u.reason === "revoked"
                ? "QR revocado. No hay enlace vigente."
                : "Todavía no tiene QR."}
          </p>
          {u.reason === "legacy" && (
            <>
              <TextField
                label={`Enlace original de ${tableName(u.tableId)}`}
                value={legacyLink}
                onChange={(e) => setLegacyLink(e.target.value)}
              />
              <Button
                variant="outline"
                disabled={pending || !legacyLink}
                onClick={() =>
                  void run(async () => {
                    const token = new URL(legacyLink).searchParams.get("t")
                    if (!token) throw new Error("El enlace debe incluir el secreto del QR original.")
                    const result = await saveCarta("importarQrMesa", { ...scope, tableId: u.tableId, token })
                    setTokens((x) => [...x.filter((t) => t.tableId !== u.tableId), ...result.tokens])
                    setUnavailable((x) => x.filter((t) => t.tableId !== u.tableId))
                    setLegacyLink("")
                    setMessage("Enlace original recuperado. La placa sigue siendo válida.")
                  })
                }
              >
                Importar enlace original
              </Button>
            </>
          )}
        </div>
      ))}
      <details className="border-t pt-3">
        <summary className="flex min-h-12 cursor-pointer items-center text-sm font-medium">
          Cambiar o revocar enlaces
        </summary>
        <p className="my-3 text-sm text-muted-foreground">
          Generar códigos nuevos invalida las placas anteriores. Revocar retira el acceso sin crear otro
          enlace.
        </p>
        <Toggle
          label="Entiendo que las placas anteriores dejarán de funcionar"
          checked={confirmed}
          onChange={setConfirmed}
        />
        <div className="mt-3 flex flex-wrap gap-3">
          <Button
            variant="outline"
            disabled={pending || !selected.length || !confirmed}
            onClick={() =>
              void run(async () => {
                const result = await saveCarta("regenerarQrMesa", { ...scope, tableIds: selected })
                setTokens(result.tokens)
                setUnavailable([])
                setConfirmed(false)
                setMessage("Códigos nuevos guardados. Ya puedes descargarlos y recuperarlos en otra visita.")
              })
            }
          >
            Generar códigos nuevos
          </Button>
          <Button
            variant="outline"
            disabled={pending || !selected.length || !confirmed}
            onClick={() =>
              void run(async () => {
                await saveCarta("revocarQrMesa", { ...scope, tableIds: selected })
                setTokens([])
                setUnavailable([])
                setConfirmed(false)
                setMessage("QR revocados. No se ha creado ningún enlace nuevo.")
              })
            }
          >
            Revocar sin sustituir
          </Button>
        </div>
      </details>
      <div className="grid gap-6 sm:grid-cols-2">
        {tokens.map((t) => {
          const url = new URL(t.path, process.env.NEXT_PUBLIC_SITE_URL || window.location.origin).href
          const svg = qrPlateSvg(url, tableName(t.tableId), restaurant.name)
          return (
            <article key={t.tableId} className="space-y-3 border-t pt-4">
              <h3 className="font-medium">{tableName(t.tableId)}</h3>
              <Image
                unoptimized
                width={300}
                height={370}
                alt={`Placa QR de ${tableName(t.tableId)}`}
                className="h-auto w-full max-w-72 rounded-lg"
                src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
              />
              <div className="flex flex-wrap items-center gap-4">
                <a
                  className="flex min-h-12 items-center text-sm underline"
                  download={`mesa-${t.tableId}.svg`}
                  href={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}
                >
                  Descargar SVG
                </a>
                <Button
                  variant="outline"
                  disabled={pending}
                  onClick={() =>
                    void run(async () => {
                      await downloadQrPng(svg, `mesa-${t.tableId}.png`)
                      setMessage("Imagen PNG preparada para imprimir.")
                    })
                  }
                >
                  Descargar PNG
                </Button>
              </div>
              <TextField
                label="Enlace para la etiqueta NFC"
                readOnly
                value={url}
                onFocus={(e) => e.target.select()}
              />
              <Button
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    await navigator.clipboard.writeText(url)
                    setMessage("Enlace copiado.")
                  })
                }
              >
                Copiar enlace NFC
              </Button>
            </article>
          )
        })}
      </div>
    </section>
  )
}
