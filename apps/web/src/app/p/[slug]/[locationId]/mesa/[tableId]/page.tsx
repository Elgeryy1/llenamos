import { Suspense } from 'react'
import { PublicProvider } from '@/components/publica/PublicContext'
import { CargandoPublica } from '@/components/publica/Cargando'
import { pickLanguage } from '@/lib/publica/i18n'
import { PartsApp } from '@/components/pago-movil/PartsApp'
export const metadata = { title: 'Elige tu parte', robots: { index: false, follow: false }, referrer: 'no-referrer' as const }
type Props = { params: Promise<{ slug: string; locationId: string; tableId: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }
export default function Page(props: Props) { return <Suspense fallback={<CargandoPublica />}><Content {...props} /></Suspense> }
async function Content({ params, searchParams }: Props) {
  const [p, q] = await Promise.all([params, searchParams])
  return <PublicProvider initialLang={pickLanguage(q.lang, 'es')}><PartsApp link={{ ...p, token: typeof q.t === 'string' ? q.t : '' }} /></PublicProvider>
}
