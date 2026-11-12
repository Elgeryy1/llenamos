"use client"

import type { PurchaseOrderWithId, SupplierWithId } from "@llenamos/core"
import { CheckIcon, CopyIcon } from "@phosphor-icons/react"
import { useMemo, useRef, useState } from "react"
import { SegmentedControl } from "@/components/common/segmented-control"
import { Button } from "@/components/ui/button"
import { Field, FieldLabel } from "@/components/ui/field"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { textoPedido } from "@/lib/compras/texto"
import type { Base } from "./lecturas"

/**
 * El texto del pedido listo para pegar en WhatsApp, un correo o leer por teléfono. Llenamos no
 * envía nada: lo copia el encargado y es él quien marca el pedido como enviado.
 */
export function TextoPedido({ pedido, proveedor, base, restaurante, local, hayRecepciones }: { pedido: PurchaseOrderWithId; proveedor: SupplierWithId; base: Base; restaurante: string; local: string; hayRecepciones: boolean }) {
  const [conPrecios, setConPrecios] = useState(false)
  const [que, setQue] = useState<"completo" | "pendiente">("completo")
  const [copiado, setCopiado] = useState<"si" | "no" | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const texto = useMemo(
    () =>
      textoPedido(pedido, proveedor, {
        restaurante,
        local,
        conPrecios,
        soloPendiente: que === "pendiente",
        unidadDe: (id) => base.ingredientePorId.get(id)?.unit ?? "u",
      }),
    [pedido, proveedor, restaurante, local, conPrecios, que, base],
  )

  async function copiar() {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado("si")
    } catch {
      // Sin permiso del portapapeles se deja el texto seleccionado para copiarlo a mano.
      area.current?.focus()
      area.current?.select()
      setCopiado("no")
    }
  }

  return (
    <section aria-label="Texto del pedido" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold">Texto del pedido</h3>
        {hayRecepciones ? (
          <SegmentedControl
            label="Qué incluir"
            value={que}
            onValueChange={(v) => {
              setQue(v)
              setCopiado(null)
            }}
            options={[
              { value: "completo", label: "Pedido completo" },
              { value: "pendiente", label: "Solo lo pendiente" },
            ]}
          />
        ) : null}
      </div>
      <Textarea
        ref={area}
        readOnly
        aria-label="Texto del pedido para copiar"
        value={texto}
        rows={Math.min(16, texto.split("\n").length + 1)}
        onFocus={(e) => e.currentTarget.select()}
        className="resize-none bg-surface-sunken leading-relaxed"
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Field orientation="horizontal" className="w-auto">
          <Checkbox
            id="texto-precios"
            checked={conPrecios}
            onCheckedChange={(v) => {
              setConPrecios(v === true)
              setCopiado(null)
            }}
          />
          <FieldLabel htmlFor="texto-precios" className="font-normal">
            Con precios y total
          </FieldLabel>
        </Field>
        <Button type="button" variant="outline" size="lg" onClick={copiar}>
          {copiado === "si" ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
          {copiado === "si" ? "Copiado" : "Copiar texto"}
        </Button>
      </div>
      <p role="status" className="min-h-4 text-xs text-muted-foreground">
        {copiado === "si"
          ? "Texto copiado. Pégalo donde vayas a hacer el pedido."
          : copiado === "no"
            ? "Tu navegador no deja copiar solo: el texto está seleccionado, cópialo con Control C."
            : "Llenamos no envía el pedido. Cópialo y mándalo tú por WhatsApp, correo o teléfono."}
      </p>
    </section>
  )
}
