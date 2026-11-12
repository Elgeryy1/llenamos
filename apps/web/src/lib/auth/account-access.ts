"use client"

import type { User } from "firebase/auth"
import { useEffect, useState } from "react"
import { dataBackend } from "@/lib/api/config"
import { readSession, type ApiSession } from "@/lib/api/session"
import { ApiCallError, type OperationOptions } from "@/lib/api/transport"
import { firebaseConfig } from "@/lib/firebase/config"
import type { Live } from "@/lib/firebase/live"
import { restaurantDestination } from "./login-destination"

export type AccountAccess =
  | { source: "postgres"; uid: string; access: ApiSession["access"]; session: ApiSession }
  | { source: "firebase-demo"; uid: string; access: "platform" | "restaurant" }

/** Auth acredita identidad; en VPS solo SQL decide si es plataforma o restaurante. */
export async function readAccountAccess(user: User, options: Omit<OperationOptions, "authentication"> = {}): Promise<AccountAccess> {
  const backend = dataBackend(firebaseConfig.ok ? firebaseConfig.settings : null)
  if (backend === "postgres") {
    const session = await readSession(user.uid, { ...options, getToken: options.getToken ?? (() => user.getIdToken(true)) })
    return { source: "postgres", uid: user.uid, access: session.access, session }
  }
  const token = await user.getIdTokenResult(true)
  return { source: "firebase-demo", uid: user.uid, access: token.claims.logiqd === true ? "platform" : "restaurant" }
}

export function hasRestaurantAccess(access: AccountAccess): boolean {
  return access.access === "restaurant" && (access.source === "firebase-demo" || access.session.memberships.length > 0)
}

/** El parámetro acceso de la landing expresa intención; no interviene en permisos. */
export function accountDestination(access: AccountAccess, requested: string | null): string {
  if (access.access === "platform") return "/logiqd"
  if (!hasRestaurantAccess(access)) throw new ApiCallError("permission-denied", "Tu cuenta no tiene restaurantes asignados. Pide al propietario o al equipo LogiQD que configure tu acceso.")
  return restaurantDestination(requested)
}

export function useAccountAccess(user: User): Live<AccountAccess> {
  const [stored, setStored] = useState<{ user: User; value: Live<AccountAccess> } | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void readAccountAccess(user, { signal: controller.signal }).then(
      data => { if (!controller.signal.aborted) setStored({ user, value: { status: "ready", data } }) },
      error => { if (!controller.signal.aborted) setStored({ user, value: { status: "error", error } }) },
    )
    return () => controller.abort()
  }, [user])
  return stored?.user === user ? stored.value : { status: "loading" }
}
