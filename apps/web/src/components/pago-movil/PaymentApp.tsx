"use client"
import { useEffect, useRef, useState } from 'react'
import { CheckCircleIcon, LockKeyIcon, ReceiptIcon, ArrowRightIcon } from '@phosphor-icons/react'
import { FiscalRecipientSchema } from '@llenamos/core'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Notice } from '@/components/common/notice'
import { PublicShell } from '@/components/publica/PublicShell'
import { usePublic } from '@/components/publica/PublicContext'
import { mobileCall, MobileError, money, privatePath, stripeRedirect, tipFromText, type CheckoutLink, type PublicBill } from '@/lib/pago-movil/api'
import { texts } from '@/lib/pago-movil/textos'
import { useMobileQuery } from '@/lib/pago-movil/use-query'

export function PaymentApp({ link }: { link: CheckoutLink }) {
  const query = useMobileQuery('verCobroPublico', link)
  const { lang } = usePublic(), t = texts(lang), bill = query.result
  useEffect(() => {
    if (!bill) return
    try { sessionStorage.setItem(`llenamos:mobile:${link.checkoutId}`, window.location.pathname + window.location.search) } catch { /* Recuperación opcional en este dispositivo. */ }
  }, [bill, link.checkoutId])
  return <PublicShell name={bill?.restaurantName ?? null} brandColor={bill?.brandColor ?? null} title={t.title} subtitle={bill?.locationName ?? t.intro}>
    {!bill ? <Notice tone={query.error ? 'error' : 'info'} action={query.error ? <Button className="min-h-12" variant="outline" onClick={query.refresh}>{t.retry}</Button> : null}>{query.error ? t.error : t.loading}</Notice> :
      <div className="space-y-5">
        <section className="superficie overflow-hidden">
          <div className="flex items-center justify-between gap-4 border-b p-5"><span className="text-sm text-muted-foreground">{bill.label}</span><ReceiptIcon className="size-6 text-[var(--brand-text)]" aria-hidden /></div>
          <div className="p-5"><p className="text-sm text-muted-foreground">{bill.status === 'paid' ? t.paidPart : t.part}</p><p className="cifra mt-2 text-5xl font-semibold tracking-tight">{money(bill.status === 'paid' ? bill.paidCents : bill.amountCents, lang)}</p></div>
          <ul className="divide-y border-t">{bill.lines.map((line, i) => <li key={i} className="flex justify-between gap-5 px-5 py-4 text-sm"><span>{line.name}</span><span className="cifra shrink-0">{money(line.amountCents, lang)}</span></li>)}</ul>
        </section>
        {bill.status === 'paid' ? <><Notice tone="success" title={t.paid}>{t.thanks}</Notice>{bill.tipCents > 0 ? <p className="text-sm">{t.tipTotal}: {money(bill.tipCents, lang)}</p> : null}
          {bill.invoicePending ? <Notice tone="warning">{t.invoicePending}</Notice> : null}
          {bill.receiptPath ? <Button asChild size="lg" className="min-h-12 w-full"><a href={privatePath(bill.receiptPath, '/recibo/')}>{t.receipt}<ArrowRightIcon aria-hidden /></a></Button> : null}
          <Delivery status={bill.delivery} /></> : bill.status !== 'pending' ? <Notice tone="warning">{bill.status === 'expired' ? t.expired : bill.status === 'reconciliation_required' ? t.review : t.failed}</Notice> :
          bill.paymentInProgress ? <><Notice>{t.pending}</Notice>{bill.checkoutUrl ? <Button asChild className="min-h-12 w-full"><a href={stripeRedirect(bill.checkoutUrl)} referrerPolicy="no-referrer">{t.pay}</a></Button> : null}<Button variant="outline" className="min-h-12 w-full" onClick={query.refresh}>{t.retry}</Button></> :
          <PaymentForm key={link.checkoutId} link={link} bill={bill} onPending={query.refresh} />}
        <p className="flex items-center justify-center gap-2 text-center text-xs text-muted-foreground"><LockKeyIcon aria-hidden />{t.privacy}</p>
      </div>}
  </PublicShell>
}
function PaymentForm({ link, bill, onPending }: { link: CheckoutLink; bill: PublicBill; onPending: () => void }) {
  const { settings, lang } = usePublic(), t = texts(lang)
  const [tip, setTip] = useState('0'), [consent, setConsent] = useState(false), [email, setEmail] = useState('')
  const [full, setFull] = useState(bill.amountCents > 300000), [name, setName] = useState(''), [nif, setNif] = useState(''), [address, setAddress] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false)
  const intent = useRef<{ fingerprint: string; id: string } | null>(null)
  const guard = useRef(false)
  const cents = tipFromText(tip)
  const disabled = busy || uncertain
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (guard.current) return
    setError('')
    const recipient = full ? FiscalRecipientSchema.safeParse({ name, address, identity: { kind: 'nif', nif } }) : null
    if (cents === null || (recipient && !recipient.success)) { setError(t.invalid); return }
    const payload = { ...link, tipCents: cents, acceptDigitalReceipt: consent, email: consent && email ? email : null,
      recipient: recipient?.success ? recipient.data : null, language: lang }
    const fingerprint = JSON.stringify(payload)
    if (!intent.current || intent.current.fingerprint !== fingerprint) intent.current = { fingerprint, id: crypto.randomUUID() }
    guard.current = true; setBusy(true)
    try {
      const result = await mobileCall(settings, 'iniciarPagoCuenta', { ...payload, requestId: intent.current.id })
      if (result.status === 'not_configured') { setError(t.disabled); return }
      onPending()
      window.location.assign(stripeRedirect(result.url))
    } catch (e) {
      const unknown = !(e instanceof MobileError) || ['network', 'internal', 'UNAVAILABLE', 'DEADLINE_EXCEEDED'].includes(e.code)
      setUncertain(unknown); setError(unknown ? t.network : t.error)
      if (unknown) onPending()
    } finally { guard.current = false; setBusy(false) }
  }
  return <form onSubmit={submit} className="space-y-5">
    {!bill.paymentsEnabled ? <Notice tone="warning">{t.disabled}</Notice> : null}
    <section className="superficie space-y-4 p-5">
      <div><h2 className="text-lg font-semibold">{t.tip}</h2><p className="mt-1 text-sm text-muted-foreground">{t.tipHint}</p></div>
      <div className="grid grid-cols-3 gap-2" role="group" aria-label={t.tip}>{[0, 5, 10].map(percent => {
        const value = String(Math.round(bill.amountCents * percent / 100) / 100)
        return <Button key={percent} type="button" variant={tip === value ? 'secondary' : 'outline'} aria-pressed={tip === value} disabled={disabled} className="min-h-12" onClick={() => setTip(value)}>{percent ? `${percent} %` : t.none}</Button>
      })}</div>
      <label className="block space-y-2 text-sm" htmlFor="tip">{t.other}<Input id="tip" value={tip} onChange={e => setTip(e.target.value)} inputMode="decimal" className="mt-2 min-h-12" disabled={disabled} /></label>
    </section>
    <section className="superficie space-y-4 p-5">
      <label className="flex min-h-12 cursor-pointer items-center gap-3 text-sm"><input type="checkbox" className="size-5 shrink-0 accent-[var(--brand)]" checked={consent} disabled={disabled} onChange={e => setConsent(e.target.checked)} />{t.consent}</label>
      {consent ? <div><label htmlFor="email" className="text-sm">{t.email} <span className="text-muted-foreground">({t.optional})</span></label><Input id="email" type="email" maxLength={254} autoComplete="email" value={email} disabled={disabled} onChange={e => setEmail(e.target.value)} className="mt-2 min-h-12" /><p className="mt-2 text-xs text-muted-foreground">{t.emailHint}</p></div> : <p className="text-sm text-muted-foreground">{t.paper}</p>}
      <label className="flex min-h-12 cursor-pointer items-center gap-3 border-t pt-4 text-sm"><input type="checkbox" className="size-5 shrink-0 accent-[var(--brand)]" checked={full} disabled={disabled || bill.amountCents > 300000} onChange={e => setFull(e.target.checked)} />{t.full}</label>
      {full ? <div className="space-y-3">{[[t.name, name, setName, 'billing organization'], [t.nif, nif, setNif, 'off'], [t.address, address, setAddress, 'billing street-address']].map(([label, value, setter, auto], i) => <div key={i}><label htmlFor={`recipient-${i}`} className="text-sm">{label as string}</label><Input id={`recipient-${i}`} required maxLength={i === 2 ? 250 : 120} value={value as string} autoComplete={auto as string} disabled={disabled} onChange={e => (setter as (s: string) => void)(e.target.value)} className="mt-2 min-h-12" /></div>)}</div> : null}
    </section>
    <div className="flex items-center justify-between px-1"><span className="text-sm text-muted-foreground">{t.totalPay}</span><strong className="cifra text-2xl">{money(bill.amountCents + (cents ?? 0), lang)}</strong></div>
    {error ? <Notice tone="error">{error}</Notice> : null}
    {uncertain ? <Button type="button" variant="outline" className="min-h-12 w-full" onClick={() => { setUncertain(false); onPending() }}>{t.retry}</Button> : null}
    <Button size="lg" type="submit" disabled={disabled || !bill.paymentsEnabled || cents === null} className="min-h-12 w-full bg-[var(--brand)] text-[var(--brand-ink)] hover:bg-[var(--brand)]/90">{busy ? t.paying : t.pay}<ArrowRightIcon aria-hidden /></Button>
    <p className="text-center text-xs text-muted-foreground">{t.secure}</p>
  </form>
}
export function Delivery({ status }: { status: string }) {
  const { lang } = usePublic(), t = texts(lang)
  const label = status === 'failed' ? t.deliveryFailed : status === 'captured' ? t.captured : status === 'queued' ? t.queued : status === 'sent' ? t.sent : status === 'not_configured' ? t.not_configured : null
  return label ? <Notice tone={status === 'sent' ? 'success' : 'info'}>{label}</Notice> : null
}
export function ConfirmedIcon() { return <CheckCircleIcon weight="fill" className="size-10 text-success" aria-hidden /> }
