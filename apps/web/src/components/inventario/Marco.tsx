"use client"

import { BasketIcon, ClipboardTextIcon, GearIcon, ListMagnifyingGlassIcon, PackageIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import type { Permission } from "@llenamos/core"
import { can } from "@llenamos/core"
import type { ReactNode } from "react"
import { Notice } from "@/components/common/notice"
import { PageHeading } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequireModule } from "@/components/panel/RequireModule"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Button } from "@/components/ui/button"

interface Pestana {
  href: string
  etiqueta: string
  permiso: Permission
  titulo: string
  descripcion: string
  Icono: typeof PackageIcon
}

const PESTANAS: readonly Pestana[] = [
  {
    href: "/panel/inventario", etiqueta: "Existencias", permiso: "inventario.ver", Icono: PackageIcon,
    titulo: "Existencias", descripcion: "Lo que hay en el almacén, con avisos cuando algo se acaba. Apunta aquí la merma.",
  },
  {
    href: "/panel/inventario/ingredientes", etiqueta: "Ingredientes", permiso: "inventario.gestionar", Icono: BasketIcon,
    titulo: "Ingredientes", descripcion: "Qué se guarda en el almacén, en qué unidad y a partir de cuánto avisar.",
  },
  {
    href: "/panel/inventario/recuento", etiqueta: "Recuento", permiso: "inventario.gestionar", Icono: ClipboardTextIcon,
    titulo: "Recuento", descripcion: "Cuenta lo que hay por pasos sin parar el servicio. Al aplicarlo se descuenta lo vendido mientras contabas.",
  },
  {
    href: "/panel/inventario/movimientos", etiqueta: "Movimientos", permiso: "costes.ver", Icono: ListMagnifyingGlassIcon,
    titulo: "Movimientos", descripcion: "Todo lo que ha entrado y salido del almacén, con su valor. No se borra nada: las correcciones son otro movimiento.",
  },
  {
    href: "/panel/inventario/ajustes", etiqueta: "Ajustes", permiso: "inventario.gestionar", Icono: GearIcon,
    titulo: "Ajustes del inventario", descripcion: "Cuándo se descuenta el stock y si se crean avisos.",
  },
]

/** Permisos, módulo y pestañas comunes a todas las pantallas de inventario. */
export function MarcoInventario({ children }: { children: ReactNode }) {
  const { role, location } = usePanel()
  const pathname = usePathname()
  const visibles = PESTANAS.filter((p) => can(role, p.permiso))
  const actual = PESTANAS.find((p) => p.href === pathname) ?? PESTANAS[0]!
  return (
    <RequirePermission permission="inventario.ver" what="el inventario">
      <RequireModule module="inventory">
        <PageHeading title={actual.titulo} eyebrow={location?.name} description={actual.descripcion} />
        {visibles.length > 1 ? (
          <nav className="mb-5 flex gap-2 overflow-x-auto pb-1" aria-label="Inventario">
            {visibles.map(({ href, etiqueta, Icono }) => (
              <Button key={href} asChild variant={href === actual.href ? "secondary" : "ghost"} className="min-h-11 shrink-0 px-3">
                <Link href={href} aria-current={href === actual.href ? "page" : undefined}>
                  <Icono aria-hidden />
                  {etiqueta}
                </Link>
              </Button>
            ))}
          </nav>
        ) : null}
        {location ? children : <Notice>Elige un local para ver su almacén.</Notice>}
      </RequireModule>
    </RequirePermission>
  )
}
