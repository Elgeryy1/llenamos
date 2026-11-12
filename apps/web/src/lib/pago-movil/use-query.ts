"use client"
import { useEffect, useState } from 'react'
import type { z } from 'zod'
import { usePublic } from '@/components/publica/PublicContext'
import { mobileCall, schemas } from './api'

export function useMobileQuery<N extends keyof typeof schemas>(name: N, input: z.input<(typeof schemas)[N]['input']>, poll = false) {
  const { settings } = usePublic()
  const key = JSON.stringify(input)
  const [count, setCount] = useState(0)
  const [state, setState] = useState<{ key: string; result?: z.output<(typeof schemas)[N]['output']>; error?: unknown }>({ key: '' })
  const work = state.key === key ? state.result as { paymentInProgress?: boolean; invoicePending?: boolean } | undefined : undefined
  const shouldPoll = poll || !!work?.paymentInProgress || !!work?.invoicePending
  useEffect(() => {
    let active = true
    void mobileCall(settings, name, JSON.parse(key)).then(result => { if (active) setState({ key, result }) })
      .catch(error => { if (active) setState({ key, error }) })
    return () => { active = false }
  }, [name, key, settings, count])
  useEffect(() => {
    if (!shouldPoll) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') setCount(c => c + 1) }, 5000)
    return () => clearInterval(timer)
  }, [shouldPoll])
  return { result: state.key === key ? state.result : undefined, error: state.key === key ? state.error : undefined, refresh: () => setCount(c => c + 1) }
}
