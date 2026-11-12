import { Suspense } from 'react'
import { PublicProvider } from '@/components/publica/PublicContext'
import { CargandoPublica } from '@/components/publica/Cargando'
import { pickLanguage } from '@/lib/publica/i18n'
import { PaymentApp } from '@/components/pago-movil/PaymentApp'
export const metadata = { title: 'Pago de tu cuenta', robots: { index: false, follow: false }, referrer: 'no-referrer' as const }
type Props = { params: Promise<{ slug: string; locationId: string; checkoutId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }
export default function Page(props: Props) { return <Suspense fallback={<CargandoPublica />}><Content {...props} /></Suspense> }
async function Content({ params, searchParams }: Props) {
  const [p, q] = await Promise.all([params, searchParams])
  return <PublicProvider initialLang={pickLanguage(q.lang, 'es')}><PaymentApp link={{ ...p, token: typeof q.t === 'string' ? q.t : '' }} /></PublicProvider>
}
