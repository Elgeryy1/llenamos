"use client"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import type { CallableInput, CallableOutput } from "@llenamos/core"
import { callService, type PublicCallable } from "@/lib/carta/callables"

export function usePublicCall<N extends PublicCallable>(name: N, input: CallableInput<N> | null, poll = false) {
  const key = JSON.stringify([name, input])
  const [state, setState] = useState<{ key: string; data?: CallableOutput<N>; error?: unknown }>({ key: "" })
  const inFlight = useRef<string | null>(null)
  const read = useEffectEvent(async () => {
    if (input === null || inFlight.current === key) return
    inFlight.current = key
    try {
      const data = await callService(name, input)
      setState({ key, data })
    } catch (error) {
      setState((previous) => ({ key, data: previous.key === key ? previous.data : undefined, error }))
    } finally {
      if (inFlight.current === key) inFlight.current = null
    }
  })
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    void read()
    if (!poll) return
    const timer = setInterval(() => {
      if (!document.hidden) void read()
    }, 15_000)
    return () => clearInterval(timer)
  }, [key, poll, refresh])
  return {
    data: state.key === key ? state.data : undefined,
    error: state.key === key ? state.error : undefined,
    refresh: () => setRefresh((n) => n + 1),
  }
}
