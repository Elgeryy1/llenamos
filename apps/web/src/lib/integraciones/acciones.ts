"use client"

import { useRef, useState } from "react"
import { canonicalJson, type CallableInput, type CallableOutput, type CallableWithSchema } from "@llenamos/core"
import { llamarCore } from "@/lib/data/callables"

/** Ante una respuesta incierta conserva el id y la entrada exacta en el mismo formulario. */
export function usePlatformMutation() {
  const intent = useRef<{ signature: string; id: string } | null>(null)
  const lock = useRef(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function mutate<N extends CallableWithSchema>(name: N, input: Omit<CallableInput<N>, "requestId">): Promise<CallableOutput<N> | null> {
    if (lock.current) return null
    lock.current = true; setPending(true); setError(null)
    const signature = canonicalJson({ name, input })
    if (intent.current?.signature !== signature) intent.current = { signature, id: crypto.randomUUID() }
    try {
      const output = await llamarCore(name, { ...input, requestId: intent.current.id } as CallableInput<N>)
      intent.current = null
      return output
    } catch (e) { setError(e instanceof Error ? e.message : "No se ha podido completar la operación."); return null }
    finally { lock.current = false; setPending(false) }
  }
  return { mutate, pending, error }
}
