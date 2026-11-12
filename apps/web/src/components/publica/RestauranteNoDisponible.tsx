"use client"

/** Lo que se enseña cuando no se puede reservar: no existe, sin módulo, sin reservas web o sin conexión. */
import { CalendarXIcon, MagnifyingGlassIcon, PhoneIcon, WifiSlashIcon } from "@phosphor-icons/react"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import type { Problema } from "@/lib/publica/problema"
import { phoneOf, telHref } from "@/lib/publica/reserva"
import { usePublic } from "./PublicContext"
import { PublicShell } from "./PublicShell"

export function RestauranteNoDisponible({ problema }: { problema: Problema }) {
  const { t } = usePublic()
  const restaurant = problema.kind === "disabled" ? problema.restaurant : null
  const phone = restaurant ? phoneOf(restaurant, null) : null

  let title: string
  let body: string
  let icon: React.ReactNode
  switch (problema.kind) {
    case "not_found":
      title = t("notFoundTitle")
      body = t("notFoundBody")
      icon = <MagnifyingGlassIcon aria-hidden />
      break
    case "unavailable":
      title = t("unavailableTitle")
      body = t("unavailableBody")
      icon = <WifiSlashIcon aria-hidden />
      break
    case "invalid":
      title = t("invalidDataTitle")
      body = t("invalidDataBody")
      icon = <CalendarXIcon aria-hidden />
      break
    case "disabled": {
      const r = problema.restaurant
      title =
        r.bookingDisabledReason === "module_off"
          ? t("moduleOffTitle", { name: r.name })
          : r.locations.length === 0 && r.bookingDisabledReason === null
            ? t("noLocationsTitle", { name: r.name })
            : t("bookingOffTitle", { name: r.name })
      body = t("bookingOffBody")
      icon = <CalendarXIcon aria-hidden />
      break
    }
  }

  return (
    <PublicShell name={restaurant?.name ?? null} brandColor={restaurant?.brandColor ?? null} compactHeader>
      <Empty className="superficie rounded-2xl py-10">
        <EmptyHeader>
          <EmptyMedia variant="icon">{icon}</EmptyMedia>
          <EmptyTitle role="heading" aria-level={1} className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">
            {title}
          </EmptyTitle>
          <EmptyDescription>{body}</EmptyDescription>
        </EmptyHeader>
        {phone ? (
          <EmptyContent>
            <Button asChild size="xl" variant="outline" className="w-full">
              <a href={telHref(phone)}>
                <PhoneIcon aria-hidden />
                {t("callPhone", { phone })}
              </a>
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
      {problema.kind === "invalid" && process.env.NODE_ENV !== "production" ? (
        <Notice tone="warning" title="Detalle para el equipo (solo en desarrollo)" className="mt-5">
          <ul className="list-disc pl-4">
            {problema.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Notice>
      ) : null}
    </PublicShell>
  )
}
