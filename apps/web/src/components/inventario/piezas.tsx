"use client"

import { can } from "@llenamos/core"
import type { ReactNode } from "react"
import { LoadingBlock } from "@/components/common/loading"
import { Notice } from "@/components/common/notice"
import { LiveError } from "@/components/panel/LiveError"
import { usePanel } from "@/components/panel/PanelContext"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import type { Alcance } from "@/lib/inventario/acciones"
import { rutaLocal } from "@/lib/inventario/datos"
import type { ErrorInfo } from "@/lib/firebase/errors"
import type { Live } from "@/lib/api/live"

/** Local elegido, su ruta en Firestore y lo que puede hacer la persona con el rol que tiene. */
export function useLocalInventario() {
  const { restaurant, location, role, user } = usePanel()
  const alcance: Alcance | null = location ? { restaurantId: restaurant.id, locationId: location.id } : null
  return {
    alcance,
    base: rutaLocal(restaurant.id, location?.id ?? null),
    uid: user.uid,
    role,
    timezone: restaurant.timezone,
    puede: {
      ver: can(role, "inventario.ver"),
      mermar: can(role, "inventario.mermar"),
      gestionar: can(role, "inventario.gestionar"),
      costes: can(role, "costes.ver"),
      recetas: can(role, "escandallos.editar"),
    },
  }
}

/** Enseña la carga, el error o los datos de una lectura en directo. */
export function Cargado<T>({ live, label, children }: { live: Live<T>; label: string; children: (datos: T) => ReactNode }) {
  if (live.status === "loading") return <LoadingBlock label={`Cargando ${label}…`} />
  if (live.status === "error") return <LiveError title={`No se puede leer ${label}`} error={live.error} />
  return <>{children(live.data)}</>
}

export function ErrorAccion({ error }: { error: ErrorInfo | null }) {
  if (!error) return null
  return (
    <Notice tone="error" title="No se ha podido guardar" detail={error.code}>
      {error.message}
    </Notice>
  )
}

/** Botón que muestra el giro mientras la llamada está en marcha. */
export function BotonAccion({
  busy,
  children,
  ocupado,
  ...props
}: Omit<React.ComponentProps<typeof Button>, "children"> & { busy: boolean; children: ReactNode; ocupado?: string }) {
  return (
    <Button disabled={busy || props.disabled} {...props}>
      {busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
      {busy && ocupado ? ocupado : children}
    </Button>
  )
}
