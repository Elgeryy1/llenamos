"use client"

/** Aceptar la mesa que ofrece la lista de espera (`aceptarOfertaListaEspera`) desde el enlace del aviso. */
import { ArmchairIcon } from "@phosphor-icons/react"
import type { PublicRestaurant } from "@llenamos/core"
import { useRouter } from "next/navigation"
import { useState } from "react"
import { callPublic } from "@/lib/publica/callables"
import { bookingHref, manageHref } from "@/lib/publica/enlaces"
import { describePublicError, type ShownError } from "@/lib/publica/errores"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Ocupado } from "./bloques"
import { usePublic } from "./PublicContext"
import { PublicShell } from "./PublicShell"

export function OfertaListaEspera({
  restaurant,
  slug,
  waitlistId,
  token,
}: {
  restaurant: PublicRestaurant
  slug: string
  waitlistId: string
  token: string | null
}) {
  const { t, lang, settings } = usePublic()
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<ShownError | null>(null)

  async function aceptar() {
    if (!token) return
    setBusy(true)
    setError(null)
    try {
      const out = await callPublic(settings, "aceptarOfertaListaEspera", { slug, waitlistId, token, website: "" })
      router.push(manageHref(slug, out.reference, out.manageToken, lang, true))
    } catch (e) {
      setError(describePublicError(e, lang, t))
      setBusy(false)
    }
  }

  const expired = error?.key === "errOfferExpired" || error?.key === "errOfferGone"

  return (
    <PublicShell name={restaurant.name} brandColor={restaurant.brandColor} compactHeader>
      <div className="superficie flex flex-col gap-5 rounded-2xl p-5 sm:p-6">
        <span aria-hidden className="flex size-12 items-center justify-center rounded-2xl border bg-surface-raised text-[var(--brand-text)]"><ArmchairIcon className="size-6" /></span>
        <h1 className="text-[24px] leading-tight font-semibold tracking-tight sm:text-[32px] text-balance">
          {token ? t("offerTitle") : t("missingToken")}
        </h1>
        {token ? <p className="text-[15px] text-muted-foreground">{t("offerBody")}</p> : null}
        {error ? <Notice tone="error" title={error.message} /> : null}
        <div className="flex flex-col gap-2">
          {token && !expired ? (
            <Button size="xl" className="w-full" disabled={busy} onClick={aceptar}>
              <Ocupado busy={busy} />
              {busy ? t("accepting") : t("acceptOffer")}
            </Button>
          ) : null}
          <Button asChild size="xl" variant="outline" className="w-full">
            <a href={bookingHref(slug, lang)}>{t("newBooking")}</a>
          </Button>
        </div>
      </div>
    </PublicShell>
  )
}
