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

/** `/r/{slug}`: la página de reservas del restaurante (y el enlace corto para Instagram y Google Maps). */
export async function generateMetadata({ params, searchParams }: PageProps<"/r/[slug]">): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  return publicMetadata(await getPublicRestaurant(slug), query.lang, "booking")
}

export default function ReservarPage(props: PageProps<"/r/[slug]">) {
  return (
    <Suspense fallback={<CargandoPublica />}>
      <Reservar {...props} />
    </Suspense>
  )
}

async function Reservar({ params, searchParams }: PageProps<"/r/[slug]">) {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  const result = await getPublicRestaurant(slug)
  await connection()
  const problema = problemaDe(result)
  const lang = pickLanguage(query.lang, result.status === "ok" ? result.restaurant.locale : "es")
  return (
    <PublicProvider initialLang={lang}>
      {problema || result.status !== "ok" ? (
        <RestauranteNoDisponible problema={problema ?? { kind: "unavailable" }} />
      ) : (
        <ReservaApp restaurant={result.restaurant} slug={slug} today={requestToday(result.restaurant.timezone)} />
      )}
    </PublicProvider>
  )
}
