"use client"

// Bloque sidebar-07 de shadcn («A sidebar that collapses to icons»), con los datos del panel.
import {
  GiftIcon,
  MegaphoneIcon,
  ChartBarIcon,
  AddressBookIcon,
  CalendarBlankIcon,
  CalendarDotsIcon,
  ChatCircleTextIcon,
  ClockCountdownIcon,
  GearSixIcon,
  HouseIcon,
  MapTrifoldIcon,
  PulseIcon,
  ShareNetworkIcon,
  SquaresFourIcon,
  UploadSimpleIcon,
  UsersThreeIcon,
  CookingPotIcon,
  NotepadIcon,
  ListChecksIcon,
  CashRegisterIcon,
  PrinterIcon,
  BagIcon,
  BookOpenTextIcon,
  SlidersHorizontalIcon,
  BeerBottleIcon,
  ClockIcon,
  UserListIcon,
  PackageIcon,
  ChefHatIcon,
  TruckIcon,
  CreditCardIcon,
  PlugsConnectedIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react"
import { restaurantModules } from "@llenamos/core"
import Link from "next/link"
import type * as React from "react"
import { usePanel } from "@/components/panel/PanelContext"
import { LogoMark } from "@/components/Wordmark"
import { Badge } from "@/components/ui/badge"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar"
import { firebaseConfig } from "@/lib/firebase/config"
import { NAV_GROUP_LABEL, navForRole, type NavGroup, type PanelSection } from "@/lib/panel/nav"
import { usePanelNavCounts } from "@/lib/panel/nav-counts"
import { NavMain } from "./nav-main"
import { NavUser } from "./nav-user"
import { RestaurantSwitcher } from "./restaurant-switcher"

/** Icono de cada sección (Phosphor, 16 px). Quien añade una sección en nav.ts, añade aquí su icono. */
export const ICONS: Record<PanelSection, React.ReactNode> = {
  fidelizacion: <GiftIcon />,
  campanas: <MegaphoneIcon />,
  analisis: <ChartBarIcon />,
  inicio: <HouseIcon />,
  sala: <SquaresFourIcon />,
  plano: <MapTrifoldIcon />,
  horarios: <CalendarDotsIcon />,
  mensajes: <ChatCircleTextIcon />,
  compartir: <ShareNetworkIcon />,
  equipo: <UsersThreeIcon />,
  actividad: <PulseIcon />,
  ajustes: <GearSixIcon />,
  reservas: <CalendarBlankIcon />,
  "lista-espera": <ClockCountdownIcon />,
  clientes: <AddressBookIcon />,
  importar: <UploadSimpleIcon />,
  comandero: <NotepadIcon />,
  comandas: <ListChecksIcon />,
  "para-llevar": <BagIcon />,
  caja: <CashRegisterIcon />,
  impresoras: <PrinterIcon />,
  fichaje: <ClockIcon />,
  personal: <UserListIcon />,
  inventario: <PackageIcon />,
  escandallos: <ChefHatIcon />,
  compras: <TruckIcon />,
  carta: <BookOpenTextIcon />,
  "configuracion-sala": <SlidersHorizontalIcon />,
  cocina: <CookingPotIcon />,
  barra: <BeerBottleIcon />,
  disponibilidad: <BookOpenTextIcon />,
  planes: <CreditCardIcon />,
  integraciones: <PlugsConnectedIcon />,
  privacidad: <ShieldCheckIcon />,
}

const GROUPS: NavGroup[] = ["servicio", "restaurante"]

export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const { role, restaurant } = usePanel()
  const items = navForRole(role, restaurantModules(restaurant))
  const counts = usePanelNavCounts(restaurant.id)
  const emulators = firebaseConfig.ok ? firebaseConfig.settings.emulators : null

  return (
    <Sidebar collapsible="icon" className="border-r-sidebar-border" {...props}>
      <SidebarHeader className="gap-3 pt-3">
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Inicio" className="pointer-coarse:h-11">
              <Link href="/panel" aria-label="llenamos, ir al inicio del panel">
                <LogoMark className="size-5" />
                <span className="text-[15px] font-semibold tracking-tight">llenamos</span>
                <span className="ml-auto text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">by LogiQD</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <RestaurantSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {GROUPS.map((group) => (
          <NavMain
            key={group}
            label={NAV_GROUP_LABEL[group]}
            items={items.filter((i) => i.group === group)}
            icons={ICONS}
            counts={counts}
          />
        ))}
      </SidebarContent>
      <SidebarFooter>
        {emulators ? (
          <Badge variant="outline" className="mx-2 self-start border-dashed font-normal text-muted-foreground group-data-[collapsible=icon]:hidden" title={`Emuladores en ${emulators.host}`}>
            Modo local con emuladores
          </Badge>
        ) : null}
        <NavUser />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
