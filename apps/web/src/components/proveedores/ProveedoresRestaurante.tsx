"use client"

import { useCallback, useEffect, useState, type FormEvent } from "react"
import { can, GuardarProveedoresRestauranteInputSchema } from "@llenamos/core"
import { Notice } from "@/components/common/notice"
import { TextField } from "@/components/common/form-fields"
import { SettingsSection } from "@/components/common/settings-section"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { isVpsBackend } from "@/lib/data/backend"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import { guardarProveedores, verProveedores, type EstadoProveedores } from "@/lib/proveedores/api"
import { cambiosDeFormulario, esVaciable, etiquetaEstado, PROVEEDORES, urlWebhook, type FichaProveedor } from "@/lib/proveedores/campos"

/**
 * Claves de los proveedores del propio restaurante. Solo el propietario, solo en el VPS (en la demo con
 * emuladores las pone LogiQD al dar de alta). Las claves van cifradas al servidor y no vuelven: la pantalla
 * solo sabe qué campos hay guardados.
 */
export function ProveedoresRestaurante() {
  const { restaurant, role } = usePanel()
  if (!isVpsBackend() || !can(role, "propietarios.gestionar")) return null
  return <Contenido key={restaurant.id} restaurantId={restaurant.id} />
}

function Contenido({ restaurantId }: { restaurantId: string }) {
  const [estado, setEstado] = useState<EstadoProveedores | null>(null)
  const [error, setError] = useState<ErrorInfo | null>(null)

  const cargar = useCallback(async () => {
    try {
      setEstado(await verProveedores(restaurantId))
      setError(null)
    } catch (e) {
      setError(describeError(e))
    }
  }, [restaurantId])
  useEffect(() => { const t = setTimeout(() => void cargar(), 0); return () => clearTimeout(t) }, [cargar])

  return (
    <SettingsSection
      id="proveedores"
      title="Tus proveedores"
      description="Las claves de tus servicios las pones tú. Quedan cifradas en el servidor y no se vuelven a mostrar, ni siquiera a ti. Lo que dejes sin configurar queda desactivado."
    >
      {error ? <Notice tone="error" title="No se han podido cargar los proveedores">{error.message}</Notice> : null}
      {!estado && !error ? <p role="status" className="text-sm text-muted-foreground">Cargando…</p> : null}
      {estado ? (
        <div className="flex flex-col gap-6">
          {PROVEEDORES.map((ficha) => (
            <Ficha key={ficha.id} ficha={ficha} restaurantId={restaurantId} estado={estado} onChange={setEstado} />
          ))}
        </div>
      ) : null}
    </SettingsSection>
  )
}

function Ficha({ ficha, restaurantId, estado, onChange }: { ficha: FichaProveedor; restaurantId: string; estado: EstadoProveedores; onChange: (e: EstadoProveedores) => void }) {
  const [valores, setValores] = useState<Record<string, string>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const [hecho, setHecho] = useState<string | null>(null)
  const [confirmarQuitar, setConfirmarQuitar] = useState(false)

  const actual = estado.providers[ficha.id]
  const guardados = new Set(estado.savedFields[ficha.id] ?? [])
  const cambios = cambiosDeFormulario(ficha, valores)
  const hayCambios = Object.keys(cambios).length > 0
  const webhook = ficha.id === "stripe" || ficha.id === "whatsapp" ? urlWebhook(typeof window === "undefined" ? "" : window.location.origin, ficha.id, restaurantId) : null

  async function ejecutar(accion: () => ReturnType<typeof guardarProveedores>, mensaje: string) {
    setPending(true)
    setError(null)
    setHecho(null)
    try {
      onChange(await accion())
      setValores({})
      setConfirmarQuitar(false)
      setHecho(mensaje)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setPending(false)
    }
  }

  function guardar(event: FormEvent) {
    event.preventDefault()
    if (!hayCambios) return
    // El servidor vuelve a validar; aquí se avisa del formato antes de enviar nada.
    const parsed = GuardarProveedoresRestauranteInputSchema.safeParse({ restaurantId, integrations: cambios })
    if (!parsed.success) {
      setHecho(null)
      setError({ message: parsed.error.issues[0]?.message ?? "Revisa los datos.", code: "invalid-argument" })
      return
    }
    void ejecutar(() => guardarProveedores(restaurantId, cambios), "Guardado.")
  }

  return (
    <form onSubmit={guardar} className="flex flex-col gap-4 border-b pb-6 last:border-b-0 last:pb-0" aria-labelledby={`prov-${ficha.id}`} autoComplete="off">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`prov-${ficha.id}`} className="font-medium">{ficha.title}</h3>
        <span className="text-sm text-muted-foreground" role="status">{etiquetaEstado(actual)}</span>
      </div>
      <p className="text-sm text-muted-foreground">{ficha.description}</p>
      {webhook ? (
        <p className="text-sm">Dirección del webhook para {ficha.title}: <code className="break-all select-all">{webhook}</code></p>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {ficha.fields.map((campo) => (
          <TextField
            key={campo.key}
            label={campo.label}
            name={`${ficha.id}-${campo.key}`}
            type={campo.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            value={valores[campo.key] ?? ""}
            onChange={(e) => { setValores((v) => ({ ...v, [campo.key]: e.target.value })); setHecho(null) }}
            placeholder={guardados.has(campo.key) ? "Guardado, escribe para cambiarlo" : undefined}
            hint={[guardados.has(campo.key) ? "Ya hay un valor guardado; vacío lo conserva." : null, campo.hint ?? null].filter(Boolean).join(" ") || undefined}
            disabled={pending}
            trailing={guardados.has(campo.key) && esVaciable(ficha.id, campo.key) ? (
              <Button type="button" variant="ghost" size="sm" disabled={pending} aria-label={`Vaciar ${campo.label}`} onClick={() => void ejecutar(() => guardarProveedores(restaurantId, {}, [], [{ provider: ficha.id, field: campo.key }]), "Vaciado.")}>Vaciar</Button>
            ) : undefined}
          />
        ))}
      </div>
      {error ? <Notice tone="error" title="No se ha podido guardar">{error.message}</Notice> : null}
      {hecho ? <p role="status" className="text-sm text-success">{hecho}</p> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={pending || !hayCambios}>{pending ? "Guardando…" : "Guardar"}</Button>
        {actual.configured || guardados.size > 0 ? (
          confirmarQuitar ? (
            <>
              <Button type="button" variant="destructive" disabled={pending} onClick={() => void ejecutar(() => guardarProveedores(restaurantId, {}, [ficha.id]), "Quitado.")}>Sí, quitar {ficha.title}</Button>
              <Button type="button" variant="ghost" disabled={pending} onClick={() => setConfirmarQuitar(false)}>Cancelar</Button>
            </>
          ) : (
            <Button type="button" variant="outline" disabled={pending} onClick={() => setConfirmarQuitar(true)}>Quitar</Button>
          )
        ) : null}
      </div>
    </form>
  )
}
