"use client"

// Bloque sidebar-07 de shadcn (team-switcher): aquí elige restaurante y local.
import { PLAN_LABEL } from "@llenamos/core"
import { CaretUpDownIcon, CheckIcon } from "@phosphor-icons/react"
import { useState } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { useCloseOnHide } from "@/lib/open-state"
import { initials } from "@/lib/panel/equipo"
import { isLightColor } from "@/lib/panel/ajustes"

function BrandSquare({ name, color, className }: { name: string; color: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={className ?? "flex aspect-square size-8 shrink-0 items-center justify-center rounded-lg text-xs font-semibold"}
      style={{ background: color, color: isLightColor(color) ? "#1a1408" : "#f4f1ea" }}
    >
      {initials(name)}
    </span>
  )
}

export function RestaurantSwitcher() {
  const { isMobile } = useSidebar()
  const { restaurants, restaurant, locations, location, selectRestaurant, selectLocation } = usePanel()
  const [open, setOpen] = useState(false)
  useCloseOnHide(() => setOpen(false))

  const detail = [restaurant.plan ? `Plan ${PLAN_LABEL[restaurant.plan].toLowerCase()}` : null, location?.name ?? "Sin locales"]
    .filter(Boolean)
    .join(" · ")

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={`Restaurante y local: ${restaurant.name}, ${detail}`}
              className="border bg-card shadow-soft group-data-[collapsible=icon]:border-0 group-data-[collapsible=icon]:shadow-none data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <BrandSquare name={restaurant.name} color={restaurant.brandColor} />
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">{restaurant.name}</span>
                <span className="truncate text-xs text-muted-foreground">{detail}</span>
              </div>
              <CaretUpDownIcon className="ml-auto text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-60" align="start" side={isMobile ? "bottom" : "right"} sideOffset={4}>
            <DropdownMenuLabel className="text-xs text-muted-foreground">Restaurantes</DropdownMenuLabel>
            {restaurants.map((r) => (
              <DropdownMenuItem key={r.id} onSelect={() => selectRestaurant(r.id)} className="gap-2 p-2">
                <span className="flex-1 truncate">{r.name}</span>
                {r.id === restaurant.id ? <CheckIcon aria-label="elegido" className="text-primary" /> : null}
              </DropdownMenuItem>
            ))}
            {locations.length > 0 ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted-foreground">Locales</DropdownMenuLabel>
                {locations.map((l) => (
                  <DropdownMenuItem key={l.id} onSelect={() => selectLocation(l.id)} className="gap-2 p-2">
                    <span className="flex-1 truncate">{l.name}</span>
                    {l.id === location?.id ? <CheckIcon aria-label="elegido" className="text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
