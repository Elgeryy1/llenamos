"use client"

import type { User } from "firebase/auth"
import dynamic from "next/dynamic"
import type { ComponentType, ReactNode } from "react"
import { EmptyState } from "@/components/common/empty-state"
import { Button } from "@/components/ui/button"
import { dataBackend } from "@/lib/api/config"
import { useApiRestaurantContext, useApiSession } from "@/lib/api/session"
import { firebaseConfig } from "@/lib/firebase/config"
import type { LocationDoc } from "@/lib/data/parse"
import { useStoredValue } from "@/lib/stored"
import { PanelNoAccess } from "./PanelNoAccess"
import { PanelContext, type PanelContextValue } from "./PanelContext"
import { FullScreenError, PanelSkeleton, StandaloneFrame } from "./PanelStates"

/** La demo (Firestore y emuladores) se carga bajo demanda: el bundle del VPS no incluye su código. */
/** El literal de la condición lo sustituye el empaquetador: con `postgres` el trozo de la demo ni se genera. */
const DemoPanelData: ComponentType<{ user: User; children: ReactNode }> =
  process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"
    ? () => null
    : dynamic(() => import("./PanelDataDemo").then((m) => m.DemoPanelData), { ssr: false, loading: () => <PanelSkeleton /> })

function byName(a: LocationDoc, b: LocationDoc) {
  return a.name.localeCompare(b.name, "es")
}

/**
 * Carga en directo lo que necesita el panel (perfil, restaurante, ficha de
 * miembro y locales) y decide qué enseñar mientras tanto.
 */
export function PanelData({ user, children }: { user: User; children: ReactNode }) {
  let backend: ReturnType<typeof dataBackend>
  try { backend = dataBackend(firebaseConfig.ok ? firebaseConfig.settings : null) }
  catch (error) { return <FullScreenError title="No se ha podido conectar con el servidor de datos" error={error} /> }
  return backend === "postgres"
    ? <PostgresPanelData key={user.uid} user={user}>{children}</PostgresPanelData>
    : <DemoPanelData key={user.uid} user={user}>{children}</DemoPanelData>
}

function PostgresPanelData({ user, children }: { user: User; children: ReactNode }) {
  const session = useApiSession(user)
  const restaurants = session.status === "ready" && session.data.access === "restaurant"
    ? session.data.memberships.map(m => ({ id: m.restaurantId, name: m.name, role: m.role })) : []
  const [storedRid, storeRid] = useStoredValue(`llenamos:restaurante:${user.uid}`)
  const rid = (restaurants.find(r => r.id === storedRid) ?? restaurants[0])?.id ?? null
  const context = useApiRestaurantContext(user, rid)
  const [storedLid, storeLid] = useStoredValue(rid ? `llenamos:local:${user.uid}:${rid}` : null)

  if (session.status === "loading") return <PanelSkeleton />
  if (session.status === "error") return <FullScreenError title="No se ha podido cargar tu acceso" error={session.error} />
  if (session.data.access === "platform") return (
    <StandaloneFrame><EmptyState title="Tu acceso es de administración LogiQD" description="Gestiona las altas y planes desde administración." action={<Button asChild><a href="/logiqd">Ir a administración</a></Button>} /></StandaloneFrame>
  )
  if (restaurants.length === 0) return (
    <StandaloneFrame><EmptyState title="No tienes restaurantes asignados" description="Pide al propietario o al equipo LogiQD que configure tu acceso." /></StandaloneFrame>
  )
  if (context.status === "loading") return <PanelSkeleton />
  // El flujo en vivo termina con «sin permiso» cuando se desactiva a la persona: se explica, no es un fallo.
  if (context.status === "error" && (context.error as { code?: unknown } | null)?.code === "permission-denied") return <PanelNoAccess restaurants={restaurants} rid={rid} storeRid={storeRid} />
  if (context.status === "error") return <FullScreenError title="No se ha podido cargar el restaurante" error={context.error} />
  const { restaurant, member } = context.data
  const locations = [...context.data.locations].sort(byName)
  const value: PanelContextValue = {
    user, restaurants, restaurant, member, role: member.role, locations,
    location: locations.find(l => l.id === storedLid) ?? locations[0] ?? null,
    selectRestaurant: storeRid, selectLocation: storeLid,
  }
  return <PanelContext value={value}>{children}</PanelContext>
}
