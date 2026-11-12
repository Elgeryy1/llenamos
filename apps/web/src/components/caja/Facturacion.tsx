"use client"

import { useState } from "react"
import {
  FiscalRecipientSchema,
  type Bill,
  type BillPart,
  type CallableOutput,
} from "@llenamos/core"
import type { ConId } from "@/lib/caja/datos"
import type { OperacionCaja } from "@/lib/caja/useOperacion"
import { Notice } from "@/components/common/notice"
import { AvisoFiscal, Campo, Formulario, Selector } from "./piezas"

export type ClienteFactura = {
  name: string
  address: string
  nif: string
  kind: string
  country: string
  idType: string
  foreignId: string
}
export const clienteVacio: ClienteFactura = {
  name: "",
  address: "",
  nif: "",
  kind: "nif",
  country: "",
  idType: "02",
  foreignId: "",
}
export function destinatario(c: ClienteFactura) {
  return FiscalRecipientSchema.parse({
    name: c.name,
    address: c.address,
    identity:
      c.kind === "nif"
        ? { kind: "nif", nif: c.nif }
        : {
            kind: "other",
            country: c.country.toUpperCase(),
            idType: c.idType,
            id: c.foreignId,
          },
  })
}
export function DatosCliente({
  value,
  onChange,
}: {
  value: ClienteFactura
  onChange: (v: ClienteFactura) => void
}) {
  function field(key: keyof ClienteFactura, v: string) {
    onChange({ ...value, [key]: v })
  }
  return (
    <div className="space-y-4">
      <Campo
        label="Nombre o razón social"
        value={value.name}
        onChange={(v) => field("name", v)}
        required
      />
      <Campo
        label="Domicilio fiscal"
        value={value.address}
        onChange={(v) => field("address", v)}
        required
      />
      <Selector
        label="Identificación fiscal"
        value={value.kind}
        onChange={(v) => field("kind", v)}
        options={[
          { value: "nif", label: "NIF español" },
          { value: "other", label: "Otra identificación" },
        ]}
      />
      {value.kind === "nif" ? (
        <Campo
          label="NIF"
          value={value.nif}
          onChange={(v) => field("nif", v)}
          required
        />
      ) : (
        <>
          <Campo
            label="País (dos letras)"
            value={value.country}
            onChange={(v) => field("country", v)}
            required
          />
          <Selector
            label="Tipo de documento"
            value={value.idType}
            onChange={(v) => field("idType", v)}
            options={[
              { value: "02", label: "NIF IVA" },
              { value: "03", label: "Pasaporte" },
              { value: "04", label: "Documento oficial del país" },
              { value: "05", label: "Certificado de residencia" },
              { value: "06", label: "Otro documento probatorio" },
              { value: "07", label: "No censado" },
            ]}
          />
          <Campo
            label="Número de identificación"
            value={value.foreignId}
            onChange={(v) => field("foreignId", v)}
            required
          />
          <p className="text-sm text-muted-foreground">
            La compatibilidad con destinatarios extranjeros debe confirmarse con
            el proveedor. El servidor puede rechazar estos datos.
          </p>
        </>
      )}
    </div>
  )
}
export function RespuestaFactura({
  result,
}: {
  result: CallableOutput<"emitirFactura">
}) {
  return (
    <Notice tone="warning" title={`Documento ${result.number}`}>
      Proveedor de prueba: no válido para Hacienda.{" "}
      {result.fiscalStatus === "not_configured"
        ? "No se ha enviado a Hacienda."
        : "Está en cola, sin confirmación fiscal."}{" "}
      {result.warning}
    </Notice>
  )
}
export function Facturacion({
  bill,
  billId,
  parts,
  op,
  fresh,
}: {
  bill: Bill
  billId: string
  parts: ConId<BillPart>[]
  op: OperacionCaja
  fresh: boolean
}) {
  const [partId, setPartId] = useState(parts[0]?.id ?? "")
  const [type, setType] = useState("F2")
  const [client, setClient] = useState(clienteVacio)
  const [result, setResult] = useState<CallableOutput<"emitirFactura"> | null>(
    null,
  )
  const part = parts.find((p) => p.id === partId)
  return (
    <div className="space-y-4">
      <AvisoFiscal />
      <Selector
        label="Parte a facturar"
        value={partId}
        onChange={setPartId}
        options={parts.map((p) => ({
          value: p.id,
          label: `${p.label}${p.invoiceId ? " · ya facturada" : ""}`,
        }))}
      />
      <Formulario
        label="Emitir documento de prueba"
        disabled={
          op.blocked ||
          !fresh ||
          !part ||
          part.revision !== bill.revision ||
          Boolean(part.invoiceId) ||
          !["locked", "settled"].includes(bill.status)
        }
        onSubmit={async () => {
          if (!part) return
          const output = await op.run(
            "emitirFactura",
            {
              billId,
              expectedRevision: bill.revision,
              partId,
              type: type as "F1" | "F2",
              recipient: type === "F1" ? destinatario(client) : null,
            },
            (r) =>
              `Documento de prueba ${r.number}. No válido para Hacienda. ${r.warning ?? ""}`,
          )
          if (output) setResult(output)
        }}
      >
        <Selector
          label="Documento"
          value={type}
          onChange={setType}
          options={[
            { value: "F2", label: "Ticket o factura simplificada" },
            { value: "F1", label: "Factura completa con datos del cliente" },
          ]}
        />
        {type === "F1" ? (
          <DatosCliente value={client} onChange={setClient} />
        ) : (
          <p className="text-sm text-muted-foreground">
            Para importes superiores a 3.000 € o si el cliente la solicita,
            emite una factura completa. La parte se factura una sola vez aunque
            tenga varios cobros.
          </p>
        )}
      </Formulario>
      {part?.invoiceId ? (
        <Notice>
          Esta parte ya está facturada. Consulta el documento en Historial para
          obtener copia o sustituir la simplificada.
        </Notice>
      ) : null}
      {result ? <RespuestaFactura result={result} /> : null}
    </div>
  )
}
