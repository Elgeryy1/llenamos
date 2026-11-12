/**
 * Metadatos para compartir las páginas públicas (título, descripción, imagen).
 * Las páginas con enlace secreto (gestionar la reserva, aceptar una oferta) no se indexan
 * y no mandan la dirección como referente a otras webs.
 */
import type { Metadata } from "next"
import { pickLanguage, translator, INTL_LOCALE } from "./i18n"
import type { PublicRestaurantResult } from "./restaurante"

type Kind = "booking" | "manage" | "offer" | "widget"

export function publicMetadata(result: PublicRestaurantResult, requestedLang: string | string[] | undefined, kind: Kind): Metadata {
  const restaurant = result.status === "ok" ? result.restaurant : null
  const lang = pickLanguage(requestedLang, restaurant?.locale ?? "es")
  const t = translator(lang)
  const secret = kind === "manage" || kind === "offer"

  if (!restaurant) {
    return { title: t("notFoundTitle"), robots: { index: false, follow: false } }
  }

  const city = restaurant.locations.length === 1 && restaurant.locations[0]?.city ? `, ${restaurant.locations[0].city}` : ""
  const title =
    kind === "manage" ? t("metaManageTitle", { name: restaurant.name }) : kind === "offer" ? t("metaOfferTitle", { name: restaurant.name }) : t("metaTitle", { name: restaurant.name })
  const description = t("metaDescription", { name: restaurant.name, city })

  return {
    title,
    description,
    robots: secret || kind === "widget" || !restaurant.bookingEnabled ? { index: false, follow: false } : undefined,
    referrer: secret ? "no-referrer" : "strict-origin-when-cross-origin",
    openGraph: {
      type: "website",
      title,
      description,
      siteName: restaurant.name,
      locale: INTL_LOCALE[lang].replace("-", "_"),
    },
    twitter: { card: "summary_large_image", title, description },
  }
}
