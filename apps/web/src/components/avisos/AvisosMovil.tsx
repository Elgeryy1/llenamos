"use client"

import { CALLABLE_SCHEMAS, can, hasModule, type CallableOutput } from "@llenamos/core"
import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { usePanel } from "@/components/panel/PanelContext"
import { invokeOperation } from "@/lib/api/operations"
import { enVps, useServicioVivo } from "@/lib/sala/vivo"
import { describeError } from "@/lib/firebase/errors"
import { cargarClienteDemo, cargarFirestore } from "@/lib/firebase/cargar-demo"

async function llamar<N extends "configuracionPush" | "guardarSuscripcionPush">(name: N, input: unknown): Promise<CallableOutput<N>> {
  const data = CALLABLE_SCHEMAS[name].input.parse(input)
  return CALLABLE_SCHEMAS[name].output.parse(await invokeOperation(name, data)) as CallableOutput<N>
}
type Alcance = { restaurantId: string; locationId: string }
/** Al coger o cerrar una tarea se retiran sus avisos ya mostrados en este dispositivo. */
function useCerrarAvisosFs(scope: Alcance) {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return
    let stop = () => {}
    let active = true
    void Promise.all([cargarFirestore(), cargarClienteDemo()]).then(([{ collection, onSnapshot, query, where }, { getFirebase }]) => {
      if (!active) return
      const q = query(collection(getFirebase().db, `restaurants/${scope.restaurantId}/locations/${scope.locationId}/floorTasks`), where("status", "in", ["open", "claimed"]))
      stop = onSnapshot(q, snapshot => {
        for (const change of snapshot.docChanges()) if (change.type === "removed" || change.doc.get("claimedBy")) cerrarAviso(scope, change.doc.id)
      }, () => {})
    }).catch(() => {})
    return () => { active = false; stop() }
  }, [scope.restaurantId, scope.locationId]) // eslint-disable-line react-hooks/exhaustive-deps
}
/**
 * VPS: las tareas abiertas llegan del servicio en vivo; las que dejan de estar sin dueño se retiran de este dispositivo.
 * Solo se escucha con los avisos activados en este móvil (`activo`): quien no los tiene no abre ningún flujo. En la primera
 * lectura también se retiran los avisos mostrados de tareas que ya estaban cogidas o cerradas.
 */
function useCerrarAvisosVps(scope: Alcance, activo = false) {
  const servicio = useServicioVivo(activo ? scope : null)
  const sinDueno = useRef<Set<string> | null>(null)
  useEffect(() => {
    if (servicio.status !== "ready") return
    const ahora = new Set(servicio.data.tasks.filter(t => t.status === "open" && !t.claimedBy).map(t => t.id))
    if (sinDueno.current === null) {
      if ("serviceWorker" in navigator) {
        const prefijo = `task:${scope.restaurantId}:${scope.locationId}:`
        void navigator.serviceWorker.getRegistration("/panel/").then(async registration => {
          for (const notification of await registration?.getNotifications() ?? []) if (notification.tag?.startsWith(prefijo) && !ahora.has(notification.tag.slice(prefijo.length))) notification.close()
        }).catch(() => {})
      }
    } else for (const id of sinDueno.current) if (!ahora.has(id)) cerrarAviso(scope, id)
    sinDueno.current = ahora
  }, [servicio]) // eslint-disable-line react-hooks/exhaustive-deps
}
const useCerrarAvisos: (scope: Alcance, activo?: boolean) => void = enVps ? useCerrarAvisosVps : useCerrarAvisosFs
function cerrarAviso(scope: Alcance, taskId: string) {
  if (!("serviceWorker" in navigator)) return
  const tag = `task:${scope.restaurantId}:${scope.locationId}:${taskId}`
  void navigator.serviceWorker.getRegistration("/panel/").then(async registration => {
    for (const notification of await registration?.getNotifications({ tag }) ?? []) notification.close()
  }).catch(() => {})
}

export function AvisosMovil() {
  const { role, restaurant, location, user } = usePanel()
  // En el VPS el worker envía los avisos de tareas vencidas (`sala.avisos_push`); en demo, la función programada.
  if (!location || !can(role, "tareas.atender") || !hasModule(restaurant, "floor")) return null
  return <Suscripcion key={`${user.uid}:${restaurant.id}:${location.id}`} restaurantId={restaurant.id} locationId={location.id} />
}
function Suscripcion(scope: { restaurantId: string; locationId: string }) {
  const [config, setConfig] = useState<CallableOutput<"configuracionPush"> | null>(null)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState(false)
  const [subscribed, setSubscribed] = useState(false)
  const [supported, setSupported] = useState(false)
  useEffect(() => {
    let active = true
    queueMicrotask(() => { if (active) setSupported(window.isSecureContext && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window) })
    void llamar("configuracionPush", scope).then(async config => {
      if (active) setConfig(config)
      if ("serviceWorker" in navigator) {
        const registration = await navigator.serviceWorker.getRegistration("/panel/")
        const subscription = await registration?.pushManager.getSubscription()
        if (active) setSubscribed(!!subscription && config.subscribedEndpoints.includes(subscription.endpoint))
      }
    }).catch(error => { if (active) setMessage(describeError(error).message) })
    return () => { active = false }
  }, [scope.restaurantId, scope.locationId]) // eslint-disable-line react-hooks/exhaustive-deps

  useCerrarAvisos(scope, subscribed)

  async function toggle() {
    if (!config?.publicKey) return
    setBusy(true); setMessage("")
    try {
      const registration = await navigator.serviceWorker.register("/sw-plataforma.js", { scope: "/panel/" })
      // /panel no termina en barra y queda fuera de /panel/. Espera esta
      // inscripción, sin depender de que controle la página desde la que se activa.
      const worker = registration.installing ?? registration.waiting
      if (!registration.active && worker) await new Promise<void>((resolve, reject) => {
        const changed = () => {
          if (worker.state !== "activated" && worker.state !== "redundant") return
          worker.removeEventListener("statechange", changed)
          if (worker.state === "activated") resolve()
          else reject(new Error("No se pudo activar el trabajador de avisos. Vuelve a intentarlo."))
        }
        worker.addEventListener("statechange", changed)
        changed()
      })
      if (!registration.active) throw new Error("No se pudo activar el trabajador de avisos. Vuelve a intentarlo.")
      if (subscribed) {
        const subscription = await registration.pushManager.getSubscription()
        if (subscription) {
          await llamar("guardarSuscripcionPush", { ...scope, enabled: false, subscription: { endpoint: subscription.endpoint, keys: subscription.toJSON().keys } })
          await subscription.unsubscribe()
        }
        setSubscribed(false); setMessage("Avisos desactivados en este dispositivo.")
        return
      }
      const permission = await Notification.requestPermission()
      if (permission !== "granted") { setMessage(permission === "denied" ? "Permiso bloqueado. Puedes cambiarlo en los ajustes del navegador." : "No has concedido permiso. No se enviarán avisos."); return }
      if (config.localCapture) { setMessage("Permiso concedido y trabajador registrado. En local los envíos se capturan. La suscripción real al servicio del navegador se prueba en HTTPS fuera de los emuladores."); return }
      const key = Uint8Array.from(atob(config.publicKey.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0))
      let subscription = await registration.pushManager.getSubscription()
      const previousKey = subscription?.options.applicationServerKey
      if (subscription && (!previousKey || new Uint8Array(previousKey).some((byte, i) => byte !== key[i]) || previousKey.byteLength !== key.byteLength)) {
        await subscription.unsubscribe()
        subscription = null
      }
      subscription ??= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
      try { await llamar("guardarSuscripcionPush", { ...scope, enabled: true, subscription: { endpoint: subscription.endpoint, keys: subscription.toJSON().keys } }) }
      catch (error) { await subscription.unsubscribe(); throw error }
      setSubscribed(true); setMessage("Avisos activados para este local. Coger una tarea silencia sus siguientes avisos.")
    } catch (error) { setMessage(describeError(error).message) }
    finally { setBusy(false) }
  }
  return <details className="superficie mb-5 px-4 py-2 text-sm">
    <summary className="flex min-h-12 cursor-pointer items-center">Avisos al móvil · {config ? config.configured ? "Solo retrasos sin dueño" : "Sin configurar" : "Consultando configuración"}</summary>
    <div className="space-y-3 pb-3">
      <p>Solo avisa una tarea con retraso y sin responsable. No se vibra por cada plato nuevo. Coger la tarea detiene los siguientes avisos.</p>
      {!config?.configured && config ? <p className="text-warning">Sin claves VAPID válidas no se envía nada al móvil.</p> : null}
      {config?.localCapture ? <p>Emuladores locales: los avisos se guardan sin enviarlos a ningún servicio externo.</p> : null}
      {!supported ? <p>Necesitas un navegador compatible y HTTPS. En iPhone, añade Llenamos a la pantalla de inicio para activar los avisos.</p> : null}
      <Button variant="outline" className="h-12" disabled={busy || !supported || !config?.configured} onClick={() => void toggle()}>{busy ? "Comprobando…" : subscribed ? "Desactivar avisos" : config?.localCapture ? "Probar permiso en local" : "Activar avisos en este móvil"}</Button>
      {message ? <p role="status">{message}</p> : null}
    </div>
  </details>
}
