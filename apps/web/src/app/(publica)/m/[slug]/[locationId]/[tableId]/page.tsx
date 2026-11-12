import { Suspense } from "react"
import { PublicProvider } from "@/components/publica/PublicContext"
import { CargandoPublica } from "@/components/publica/Cargando"
import { pickLanguage } from "@/lib/publica/i18n"
import { MesaApp } from "@/components/mesa-publica/MesaApp"
import { PublicShell } from "@/components/publica/PublicShell"
import { publicText } from "@/lib/mesa-publica/textos"
import { Notice } from "@/components/common/notice"
export const metadata = {
  title: "Carta y pedidos",
  robots: { index: false, follow: false },
  referrer: "no-referrer" as const,
}
const one = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined)
type Props = {
  params: Promise<{ slug: string; locationId?: string; tableId?: string; reference?: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}
export default function Page(props: Props) {
  return (
    <Suspense fallback={<CargandoPublica />}>
      <Content {...props} />
    </Suspense>
  )
}
async function Content({ params, searchParams }: Props) {
  const [p, q] = await Promise.all([params, searchParams])
  return (
    <PublicProvider initialLang={pickLanguage(q.lang, "es")}>
      {one(q.t) ? (
        <MesaApp link={{ slug: p.slug, locationId: p.locationId!, tableId: p.tableId!, token: one(q.t)! }} />
      ) : (
        <PublicShell name={null} brandColor={null}>
          <Notice tone="error">{publicText(pickLanguage(q.lang, "es"), "noToken")}</Notice>
        </PublicShell>
      )}
    </PublicProvider>
  )
}
