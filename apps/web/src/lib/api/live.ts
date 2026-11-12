"use client"
/**
 * Lecturas en vivo contra la API del VPS (SSE autenticado por fetch). `name` es una LiveQuery
 * registrada en `apps/api/src/modules`; la API manda la foto actual y la repite cuando llega un
 * evento de sus temas. Mientras la API no tenga esa lectura responde «no desplegado»: nunca datos
 * inventados. Al cambiar de cuenta (o salir) la conexión se cancela y no queda estado ajeno.
 */
import { useEffect, useState } from "react"
import type { z } from "zod"
import { runLiveStream } from "./live-stream"
import { ApiCallError, trackIdentityRequest } from "./transport"

export type Live<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: unknown }

type Keyed<T> = { key: string | null; live: Live<T> }
const LOADING = { status: "loading" } as const

/** `input` null no escucha nada. La clave de la suscripción es el nombre más el contenido del input. */
export function useLiveQuery<T>(name: string, input: unknown | null, schema: z.ZodType<T>): Live<T> {
  const inputJson = input === null ? null : JSON.stringify(input)
  const key = inputJson === null ? null : `${name}:${inputJson}`
  const [state, setState] = useState<Keyed<T>>({ key: null, live: LOADING })
  useEffect(() => {
    if (key === null || inputJson === null) return
    const controller = new AbortController()
    const untrack = trackIdentityRequest(controller)
    let cleaned = false
    // Si algo externo corta la conexión (salir o cambiar de cuenta), no se sigue enseñando lo anterior.
    controller.signal.addEventListener("abort", () => { if (!cleaned) setState({ key: null, live: LOADING }) }, { once: true })
    void runLiveStream({
      name, input: JSON.parse(inputJson) as unknown, signal: controller.signal,
      getToken: async () => (await import("@/lib/firebase/auth-client")).identityToken(),
      onSnapshot: data => {
        if (controller.signal.aborted) return
        const parsed = schema.safeParse(data)
        if (parsed.success) setState({ key, live: { status: "ready", data: parsed.data } })
        else {
          controller.abort()
          setState({ key, live: { status: "error", error: new ApiCallError("internal", "La respuesta en directo no es válida.") } })
        }
      },
      onFatal: error => { if (!controller.signal.aborted) setState({ key, live: { status: "error", error } }) },
    })
    return () => { cleaned = true; controller.abort(); untrack() }
    // schema se espera estable (constante de módulo); incluirlo reabriría la conexión en cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return key !== null && state.key === key ? state.live : LOADING
}
