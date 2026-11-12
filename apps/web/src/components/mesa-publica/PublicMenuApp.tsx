"use client"
import { useState } from "react"
import { menuUi } from "@llenamos/core"
import { PublicShell } from "@/components/publica/PublicShell"
import { usePublic } from "@/components/publica/PublicContext"
import { usePublicRestaurant } from "@/lib/config/hooks"
import { publicMenuId, useMenu } from "@/lib/carta/hooks"
import { SelectField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { publicText } from "@/lib/mesa-publica/textos"
import { useNow } from "@/lib/use-now"
import { TakeawayApp } from "@/components/para-llevar-publico/TakeawayApp"
import { Catalog } from "./Catalog"
import { MenuError, NoMenu } from "./MenuState"
export function PublicMenuApp({
  slug,
  locationId,
  takeaway = false,
}: {
  slug: string
  locationId?: string
  takeaway?: boolean
}) {
  const restaurant = usePublicRestaurant(slug)
  const [chosen, setChosen] = useState(locationId ?? "")
  const { lang } = usePublic()
  const r = restaurant.status === "ready" ? restaurant.data : null
  const local = r?.locations.find((l) => l.id === chosen) ?? (chosen ? undefined : r?.locations[0])
  const menu = useMenu(r && local ? publicMenuId(r.restaurantId, local.id) : null, local ? { slug, locationId: local.id } : null)
  const now = useNow()
  return (
    <PublicShell name={r?.name ?? null} brandColor={r?.brandColor ?? null} subtitle={local?.name ?? null} title={menuUi(lang, takeaway ? "takeaway" : "menu")}>
      {restaurant.status === "error" && <MenuError error={restaurant.error} />}
      {restaurant.status === "loading" && <NoMenu loading />}
      {restaurant.status === "ready" && !r && <Notice tone="error">{publicText(lang, "noRestaurant")}</Notice>}
      {r && (
        <>
          <div className="mb-5">
            <SelectField
              label={publicText(lang, "chooseLocation")}
              className="h-12"
              value={local?.id ?? ""}
              onChange={(e) => setChosen(e.target.value)}
            >
              <option value="">{menuUi(lang, "choose")}</option>
              {r.locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </SelectField>
          </div>
          {menu.status === "error" && <MenuError error={menu.error} />}
          {menu.status === "ready" && !menu.data && <NoMenu />}
          {local && takeaway ? (
            <TakeawayApp
              key={local.id}
              slug={slug}
              locationId={local.id}
              menu={menu.status === "ready" ? menu.data : null}
              timezone={r.timezone}
            />
          ) : menu.status === "ready" && menu.data ? (
            <Catalog
              menu={menu.data}
              language={lang}
              channel="table"
              at={now.getTime()}
              canAdd={false}
              onAdd={() => {}}
            />
          ) : (
            menu.status === "loading" && <NoMenu loading />
          )}
        </>
      )}
    </PublicShell>
  )
}
