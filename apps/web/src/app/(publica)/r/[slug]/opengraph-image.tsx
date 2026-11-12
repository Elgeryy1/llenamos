import { ImageResponse } from "next/og"
import { brandPalette, initials } from "@/lib/publica/brand"
import { translator } from "@/lib/publica/i18n"
import { getPublicRestaurant } from "@/lib/publica/servidor"

/** Imagen al compartir el enlace de reservas (WhatsApp, Instagram, redes): nombre y color del restaurante. */
export const alt = "Reservar mesa"
export const size = { width: 1200, height: 630 }
export const contentType = "image/png"

export default async function Image({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  const result = await getPublicRestaurant(slug)
  const restaurant = result.status === "ok" ? result.restaurant : null
  const palette = brandPalette(restaurant?.brandColor)
  const t = translator(restaurant?.locale ?? "es")
  const city = restaurant?.locations.length === 1 ? restaurant.locations[0]?.city : null

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#131209",
          color: "#f4f1ea",
          padding: "72px 80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            width: 96,
            height: 96,
            borderRadius: 24,
            border: "2px solid rgba(244,241,234,0.12)",
            background: "#1f1f1f",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 40,
            fontWeight: 600,
            color: palette.accentText,
          }}
        >
          {restaurant ? initials(restaurant.name) : "·"}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: 76, fontWeight: 600, letterSpacing: -2, lineHeight: 1.05 }}>{restaurant?.name ?? "Llenamos"}</div>
          {city ? <div style={{ fontSize: 34, color: "#a39f95" }}>{city}</div> : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div
            style={{
              display: "flex",
              height: 84,
              padding: "0 40px",
              borderRadius: 20,
              background: palette.accent,
              color: palette.accentInk,
              fontSize: 36,
              fontWeight: 600,
              alignItems: "center",
            }}
          >
            {t("bookTable")}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: "#6f6b62" }}>
            {t("poweredBy")}&nbsp;<span style={{ color: "#a39f95" }}>llenamos</span>
          </div>
        </div>
      </div>
    ),
    size,
  )
}
