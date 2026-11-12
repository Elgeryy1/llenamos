import type { Metadata } from "next"
import { Suspense } from "react"
import { CargandoPublica } from "@/components/publica/Cargando"
import { OfertaListaEspera } from "@/components/publica/OfertaListaEspera"
import { PublicProvider } from "@/components/publica/PublicContext"
import { RestauranteNoDisponible } from "@/components/publica/RestauranteNoDisponible"
import { problemaDe } from "@/lib/publica/problema"
import { pickLanguage } from "@/lib/publica/i18n"
import { publicMetadata } from "@/lib/publica/metadatos"
import { getPublicRestaurant } from "@/lib/publica/servidor"

/** `/r/{slug}/lista-espera/{waitlistId}?t={token}`: aceptar la mesa que ofrece la lista de espera (enlace de R2). */
export async function generateMetadata({ params, searchParams }: PageProps<"/r/[slug]/lista-espera/[waitlistId]">): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  return publicMetadata(await getPublicRestaurant(slug), query.lang, "offer")
}

export default function OfertaPage(props: PageProps<"/r/[slug]/lista-espera/[waitlistId]">) {
  return (
    <Suspense fallback={<CargandoPublica compact />}>
      <Oferta {...props} />
    </Suspense>
  )
}

async function Oferta({ params, searchParams }: PageProps<"/r/[slug]/lista-espera/[waitlistId]">) {
  const [{ slug, waitlistId }, query] = await Promise.all([params, searchParams])
  const result = await getPublicRestaurant(slug)
  const lang = pickLanguage(query.lang, result.status === "ok" ? result.restaurant.locale : "es")
  const problema = problemaDe(result)
  const token = Array.isArray(query.t) ? query.t[0] : query.t
  return (
    <PublicProvider initialLang={lang}>
      {problema || result.status !== "ok" ? (
        <RestauranteNoDisponible problema={problema ?? { kind: "unavailable" }} />
      ) : (
        <OfertaListaEspera restaurant={result.restaurant} slug={slug} waitlistId={decodeURIComponent(waitlistId)} token={token ?? null} />
      )}
    </PublicProvider>
  )
}
