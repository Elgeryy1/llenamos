"use client"
import { useRef, useState } from 'react'
import { ArrowRightIcon, CheckCircleIcon } from '@phosphor-icons/react'
import { PublicShell } from '@/components/publica/PublicShell'
import { usePublic } from '@/components/publica/PublicContext'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/common/notice'
import { mobileCall, money, privatePath, type TableLink } from '@/lib/pago-movil/api'
import { texts } from '@/lib/pago-movil/textos'
import { useMobileQuery } from '@/lib/pago-movil/use-query'
export function PartsApp({ link }: { link: TableLink }) {
  const { settings, lang } = usePublic(), t = texts(lang), query = useMobileQuery('verPartesPagoMesa', link), result = query.result
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(false)
  const intent = useRef<{ part: string; request: string } | null>(null), guard = useRef(false)
  async function choose(partId: string) {
    if (!result || guard.current) return
    if (intent.current?.part !== partId) intent.current = { part: partId, request: crypto.randomUUID() }
    guard.current = true; setBusy(partId); setError(false)
    try {
      const response = await mobileCall(settings, 'elegirPartePagoMesa', { ...link, partId, billId: result.billId,
        expectedRevision: result.revision, requestId: intent.current.request })
      window.location.assign(privatePath(response.path, '/p/'))
    } catch { setError(true) }
    finally { guard.current = false; setBusy(null) }
  }
  return <PublicShell name={result?.restaurantName ?? null} brandColor={result?.brandColor ?? null} title={t.choose} subtitle={result?.locationName}>
    {!result ? <Notice tone={query.error ? 'error' : 'info'} action={query.error ? <Button variant="outline" className="min-h-12" onClick={query.refresh}>{t.retry}</Button> : null}>{query.error ? t.error : t.loading}</Notice> : <div className="space-y-5">
      <p className="text-sm text-muted-foreground">{t.chooseHint}</p>
      <section className="superficie overflow-hidden"><div className="flex items-center justify-between gap-4 border-b p-5"><span className="text-sm text-muted-foreground">{t.total}</span><strong className="cifra text-2xl">{money(result.totalCents, lang)}</strong></div>
        <ul className="divide-y">{result.parts.map(p => <li key={p.id} className="flex items-center gap-4 p-5"><div className="flex-1"><p className="font-medium">{p.label}</p><p className="cifra mt-1 text-xl">{money(p.amountCents, lang)}</p></div>{p.amountCents ? <Button className="min-h-12 max-w-40 whitespace-normal text-right" variant="outline" disabled={busy !== null} onClick={() => void choose(p.id)}>{busy === p.id ? t.busy : t.available}<ArrowRightIcon aria-hidden /></Button> : <span className="flex items-center gap-2 text-sm text-success"><CheckCircleIcon aria-hidden />{t.paidPart}</span>}</li>)}</ul>
      </section>{error ? <Notice tone="error">{t.network}</Notice> : null}
    </div>}
  </PublicShell>
}
