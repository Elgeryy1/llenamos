import { Suspense } from 'react'
import { PublicProvider } from '@/components/publica/PublicContext'
import { ReturnApp } from '@/components/pago-movil/ReturnApp'
import { pickLanguage } from '@/lib/publica/i18n'
export const metadata = { title: 'Estado del pago', robots: { index: false, follow: false }, referrer: 'no-referrer' as const }
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> }
export default function Page(props: Props) { return <Suspense fallback={null}><Content {...props} /></Suspense> }
async function Content({ searchParams }: Props) {
 const q = await searchParams
 return <PublicProvider initialLang={pickLanguage(q.lang, 'es')}><ReturnApp checkoutId={typeof q.checkout === 'string' && /^[A-Za-z0-9_]+$/.test(q.checkout) ? q.checkout : ''} /></PublicProvider>
}
