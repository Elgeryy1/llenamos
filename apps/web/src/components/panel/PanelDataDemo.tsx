"use client"

/**
 * Panel de la demo con emuladores (Firestore en directo). Solo se carga con `import()` dinámico desde
 * `PanelData.tsx` cuando el backend es `firebase-demo`: el bundle del VPS no incluye este archivo.
 */
import type { User } from "firebase/auth"
import { useMemo, type ReactNode } from "react"
import { useDemoDoc, useDemoDocs, useDemoQuery } from "@/lib/data/demo-live"
import { parseLocation, parseMember, parseRestaurant, parseUserProfile, type LocationDoc } from "@/lib/data/parse"
import type { Live } from "@/lib/api/live"
import { isPermissionDenied } from "@/lib/firebase/errors"
import { useStoredValue } from "@/lib/stored"
import { CrearRestaurante } from "./CrearRestaurante"
import { PanelContext, type PanelContextValue } from "./PanelContext"
import { PanelNoAccess } from "./PanelNoAccess"
import { FullScreenError, PanelSkeleton, StandaloneFrame } from "./PanelStates"

function byName(a: LocationDoc, b: LocationDoc) {
  return a.name.localeCompare(b.name, "es")
}

export function DemoPanelData({ user, children }: { user: User; children: ReactNode }) {
  const uid = user.uid
  const profile = useDemoDoc(`users/${uid}`, parseUserProfile)
  const restaurants = profile.status === "ready" ? profile.data.restaurants : []

  const [storedRid, storeRid] = useStoredValue(`llenamos:restaurante:${uid}`)
  const rid = (restaurants.find((r) => r.id === storedRid) ?? restaurants[0])?.id ?? null

  const restaurant = useDemoDoc(rid ? `restaurants/${rid}` : null, parseRestaurant)
  const member = useDemoDoc(rid ? `restaurants/${rid}/members/${uid}` : null, parseMember)

  // Quien tiene locationIds vacío ve todos los locales; si no, solo los suyos.
  // Las reglas no dejan pedir la colección entera a quien solo ve algunos.
  const activeMember = member.status === "ready" && member.data?.active ? member.data : null
  const allLocations = activeMember !== null && activeMember.locationIds.length === 0
  const someLocationPaths = useMemo(
    () =>
      activeMember !== null && activeMember.locationIds.length > 0 && rid
        ? [...activeMember.locationIds].sort().map((lid) => `restaurants/${rid}/locations/${lid}`)
        : null,
    [activeMember, rid],
  )
  const queried = useDemoQuery(allLocations && rid ? { path: `restaurants/${rid}/locations` } : null, parseLocation)
  const picked = useDemoDocs(someLocationPaths, parseLocation)
  const locations: Live<LocationDoc[]> = allLocations ? queried : picked

  const [storedLid, storeLid] = useStoredValue(rid ? `llenamos:local:${uid}:${rid}` : null)

  const value = useMemo<PanelContextValue | null>(() => {
    if (restaurant.status !== "ready" || !activeMember || locations.status !== "ready" || profile.status !== "ready") {
      return null
    }
    const sorted = [...locations.data].sort(byName)
    return {
      user,
      restaurants: profile.data.restaurants,
      restaurant: restaurant.data,
      member: activeMember,
      role: activeMember.role,
      locations: sorted,
      location: sorted.find((l) => l.id === storedLid) ?? sorted[0] ?? null,
      selectRestaurant: storeRid,
      selectLocation: storeLid,
    }
  }, [restaurant, activeMember, locations, profile, user, storedLid, storeRid, storeLid])

  if (profile.status === "loading") return <PanelSkeleton />
  if (profile.status === "error") return <FullScreenError title="No se ha podido cargar tu perfil" error={profile.error} />

  if (restaurants.length === 0) {
    return (
      <StandaloneFrame>
        <CrearRestaurante user={user} onCreated={storeRid} />
      </StandaloneFrame>
    )
  }

  // Primero la ficha de miembro: si no está activa, el resto de lecturas fallará por permisos.
  if (member.status === "loading") return <PanelSkeleton />
  const noAccess =
    (member.status === "error" && isPermissionDenied(member.error)) ||
    (member.status === "ready" && (member.data === null || !member.data.active))
  if (noAccess) return <PanelNoAccess restaurants={restaurants} rid={rid} storeRid={storeRid} />
  if (member.status === "error") return <FullScreenError title="No se ha podido cargar tu ficha de equipo" error={member.error} />

  if (restaurant.status === "loading" || locations.status === "loading") return <PanelSkeleton />
  if (restaurant.status === "error") return <FullScreenError title="No se ha podido cargar el restaurante" error={restaurant.error} />
  if (locations.status === "error") return <FullScreenError title="No se han podido cargar los locales" error={locations.error} />

  if (!value) return <PanelSkeleton />
  return <PanelContext value={value}>{children}</PanelContext>
}
