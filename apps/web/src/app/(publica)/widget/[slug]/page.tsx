import type { Metadata } from "next"
import { connection } from "next/server"
import { Suspense } from "react"
import { CargandoPublica } from "@/components/publica/Cargando"
import { PublicProvider } from "@/components/publica/PublicContext"
import { ReservaApp } from "@/components/publica/ReservaApp"
import { RestauranteNoDisponible } from "@/components/publica/RestauranteNoDisponible"
import { problemaDe } from "@/lib/publica/problema"
import { pickLanguage } from "@/lib/publica/i18n"
import { publicMetadata } from "@/lib/publica/metadatos"
import { getPublicRestaurant, requestToday } from "@/lib/publica/servidor"

/**
 * `/widget/{slug}`: la misma reserva en formato compacto, para el iframe que abre
 * `public/widget.js` en la web del restaurante.
 */
export async function generateMetadata({ params, searchParams }: PageProps<"/widget/[slug]">): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  return publicMetadata(await getPublicRestaurant(slug), query.lang, "widget")
}

export default function WidgetPage(props: PageProps<"/widget/[slug]">) {
  return (
    <Suspense fallback={<CargandoPublica compact />}>
      <Widget {...props} />
    </Suspense>
  )
}

async function Widget({ params, searchParams }: PageProps<"/widget/[slug]">) {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  const result = await getPublicRestaurant(slug)
  await connection()
  const problema = problemaDe(result)
  const lang = pickLanguage(query.lang, result.status === "ok" ? result.restaurant.locale : "es")
  return (
    <PublicProvider initialLang={lang} variant="widget">
      {problema || result.status !== "ok" ? (
        <RestauranteNoDisponible problema={problema ?? { kind: "unavailable" }} />
      ) : (
        <ReservaApp restaurant={result.restaurant} slug={slug} today={requestToday(result.restaurant.timezone)} />
      )}
    </PublicProvider>
  )
}
