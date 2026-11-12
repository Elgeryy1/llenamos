"use client"
import { PrinterIcon } from '@phosphor-icons/react'
import { PublicShell } from '@/components/publica/PublicShell'
import { usePublic } from '@/components/publica/PublicContext'
import { Notice } from '@/components/common/notice'
import { Button } from '@/components/ui/button'
import { money, type ReceiptLink } from '@/lib/pago-movil/api'
import { qrMatrix } from '@/lib/pago-movil/qr'
import { texts } from '@/lib/pago-movil/textos'
import { useMobileQuery } from '@/lib/pago-movil/use-query'
import { Delivery } from './PaymentApp'

export function ReceiptApp({ link }: { link: ReceiptLink }) {
  const { lang } = usePublic(), t = texts(lang), query = useMobileQuery('verReciboDigital', link), r = query.result, invoice = r?.invoice
  return <PublicShell name={r?.restaurantName ?? null} brandColor={r?.brandColor ?? null} title={t.receiptTitle} subtitle={r?.locationName}>
    {!invoice || !r ? <Notice tone={query.error ? 'error' : 'info'} action={query.error ? <Button variant="outline" className="min-h-12" onClick={query.refresh}>{t.retry}</Button> : null}>{query.error ? t.error : t.loading}</Notice> : <article className="space-y-5">
      {r.warning ? <Notice tone="warning">{r.warning.includes('no válido para Hacienda') ? t.test : r.warning}</Notice> : null}
      <section className="superficie overflow-hidden">
        {r.qrUrl ? <FiscalQr url={r.qrUrl} legend={r.legend} label={t.fiscalQr} /> : null}
        <div className="space-y-4 border-b p-5"><div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs text-muted-foreground">{t.invoice} · {invoice.type}</p><h2 className="mt-1 break-all text-xl font-semibold">{invoice.number}</h2></div><p className="text-sm text-muted-foreground">{invoice.issueDate}</p></div>
          <div className="text-sm"><p className="font-medium">{invoice.issuer.name}</p><p className="text-muted-foreground">{invoice.issuer.nif}</p><p className="text-muted-foreground">{invoice.issuer.address}</p></div>
          {invoice.recipient ? <div className="border-t pt-4 text-sm"><p className="mb-1 text-xs text-muted-foreground">{t.recipient}</p><p>{invoice.recipient.name}</p><p>{invoice.recipient.identity.kind === 'nif' ? invoice.recipient.identity.nif : invoice.recipient.identity.id}</p><p>{invoice.recipient.address}</p></div> : null}
        </div>
        <ul className="divide-y">{invoice.lines.map((l, i) => <li key={i} className="flex justify-between gap-4 p-5 text-sm"><span>{l.quantity} × {l.description}</span><span className="cifra shrink-0">{money(l.grossCents, lang)}</span></li>)}</ul>
        <div className="space-y-3 border-t p-5"><p className="text-xs text-muted-foreground">{t.tax}</p><div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground"><span>IVA</span><span className="text-right">{t.base}</span><span className="text-right">{t.taxAmount}</span></div>{invoice.taxes.map(tax => <div key={tax.taxRate} className="cifra grid grid-cols-3 gap-2 text-sm"><span>{tax.taxRate} %</span><span className="text-right">{money(tax.baseCents, lang)}</span><span className="text-right">{money(tax.taxCents, lang)}</span></div>)}</div>
        <div className="flex items-center justify-between gap-4 border-t bg-surface-raised p-5"><span>{t.total}</span><strong className="cifra text-3xl">{money(invoice.totalCents, lang)}</strong></div>
      </section>
      <Delivery status={r.delivery} />{!r.acceptedDigital ? <p className="text-sm text-muted-foreground">{t.paper}</p> : null}
      <Button className="min-h-12 w-full print:hidden" variant="outline" onClick={() => window.print()}><PrinterIcon aria-hidden />{t.print}</Button>
      <p className="text-center text-xs text-muted-foreground">{t.privacy}</p>
    </article>}
  </PublicShell>
}
function FiscalQr({ url, legend, label }: { url: string; legend: string | null; label: string }) {
  let grid: boolean[][]
  try { grid = qrMatrix(url) } catch { return <p className="p-5 text-sm">{label}: <a href={url} referrerPolicy="no-referrer" rel="noreferrer" className="underline">{label}</a></p> }
  const d = grid.flatMap((row, y) => row.flatMap((dark, x) => dark ? [`M${x + 4},${y + 4}h1v1h-1z`] : [])).join('')
  return <div className="flex flex-col items-center gap-2 border-b p-5"><p className="text-sm font-medium">{label}</p><svg role="img" aria-label={label} viewBox="0 0 65 65" className="h-[40mm] w-[40mm] bg-white" shapeRendering="crispEdges"><path fill="white" d="M0 0h65v65H0z" /><path fill="black" d={d} /></svg>{legend ? <p className="text-sm font-medium">{legend}</p> : null}</div>
}
