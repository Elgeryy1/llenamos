import type { Metadata } from "next"
import { Suspense } from "react"
import { CargandoPublica } from "@/components/publica/Cargando"
import { GestionarReserva } from "@/components/publica/GestionarReserva"
import { PublicProvider } from "@/components/publica/PublicContext"
import { RestauranteNoDisponible } from "@/components/publica/RestauranteNoDisponible"
import { problemaDe } from "@/lib/publica/problema"
import { pickLanguage } from "@/lib/publica/i18n"
import { publicMetadata } from "@/lib/publica/metadatos"
import { getPublicRestaurant } from "@/lib/publica/servidor"

/** `/r/{slug}/reserva/{referencia}?t={token}`: ver, confirmar o cancelar la reserva con el enlace. */
export async function generateMetadata({ params, searchParams }: PageProps<"/r/[slug]/reserva/[ref]">): Promise<Metadata> {
  const [{ slug }, query] = await Promise.all([params, searchParams])
  return publicMetadata(await getPublicRestaurant(slug), query.lang, "manage")
}

export default function GestionarPage(props: PageProps<"/r/[slug]/reserva/[ref]">) {
  return (
    <Suspense fallback={<CargandoPublica compact />}>
      <Gestionar {...props} />
    </Suspense>
  )
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

async function Gestionar({ params, searchParams }: PageProps<"/r/[slug]/reserva/[ref]">) {
  const [{ slug, ref }, query] = await Promise.all([params, searchParams])
  const result = await getPublicRestaurant(slug)
  const lang = pickLanguage(query.lang, result.status === "ok" ? result.restaurant.locale : "es")
  // Una reserva ya hecha se puede ver aunque el restaurante haya dejado de aceptar reservas nuevas.
  const problema = result.status === "ok" ? null : problemaDe(result)
  return (
    <PublicProvider initialLang={lang} variant={first(query.embed) === "1" ? "widget" : "page"}>
      {problema || result.status !== "ok" ? (
        <RestauranteNoDisponible problema={problema ?? { kind: "unavailable" }} />
      ) : (
        <GestionarReserva
          restaurant={result.restaurant}
          slug={slug}
          reference={decodeURIComponent(ref)}
          token={first(query.t) ?? null}
          isNew={first(query.nueva) === "1"}
        />
      )}
    </PublicProvider>
  )
}
