"use client"

// Bloque sidebar-07 de shadcn (nav-main), con enlaces directos en vez de submenús.
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { ReactNode } from "react"
import {
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { isNavActive, type NavItem } from "@/lib/panel/nav"

export function NavMain({
  label,
  items,
  icons,
  counts,
}: {
  label: string
  items: NavItem[]
  icons: Partial<Record<NavItem["section"], ReactNode>>
  /** Cifra a la derecha de una sección (reservas de hoy, personas en espera). Solo datos reales. */
  counts?: Partial<Record<NavItem["section"], number>>
}) {
  const pathname = usePathname()
  const { setOpenMobile } = useSidebar()
  if (items.length === 0) return null
  return (
    <SidebarGroup>
      <SidebarGroupLabel className="text-[11px] font-medium tracking-wide text-muted-foreground/80">{label}</SidebarGroupLabel>
      <SidebarMenu className="gap-0.5">
        {items.map((item) => {
          const active = isNavActive(pathname, item.href)
          const count = counts?.[item.section]
          return (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                asChild
                isActive={active}
                tooltip={item.label}
                className={
                  // Activo: capa alzada con su sombra y una marca fina a la izquierda.
                  "relative h-9 text-soft-foreground pointer-coarse:h-11 data-active:bg-surface-raised data-active:text-foreground data-active:shadow-soft data-active:before:absolute data-active:before:inset-y-2 data-active:before:left-0 data-active:before:w-0.5 data-active:before:rounded-full data-active:before:bg-foreground/70 [&_svg]:text-muted-foreground data-active:[&_svg]:text-foreground"
                }
              >
                <Link href={item.href} aria-current={active ? "page" : undefined} onNavigate={() => setOpenMobile(false)}>
                  {icons[item.section]}
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
              {count !== undefined ? (
                <SidebarMenuBadge className="cifra top-2! rounded-full bg-foreground/[0.07] px-1.5 text-[11px] text-soft-foreground">{count}</SidebarMenuBadge>
              ) : null}
            </SidebarMenuItem>
          )
        })}
      </SidebarMenu>
    </SidebarGroup>
  )
}
