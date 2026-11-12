"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { GiftIcon, SealPercentIcon, WalletIcon, SquaresFourIcon } from "@phosphor-icons/react"
import { restaurantModules } from "@llenamos/core"
import type { ReactNode } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import { PageHeading } from "@/components/common/page-heading"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { permitido, type Nombre } from "@/lib/fidelizacion/api"

const pestañas: { href: string; label: string; icon: typeof GiftIcon; permiso: Nombre | null }[] = [
  { href: "/panel/fidelizacion", label: "Programa y premios", icon: GiftIcon, permiso: "guardarConfiguracionFidelizacion" },
  { href: "/panel/fidelizacion/promociones", label: "Promociones", icon: SealPercentIcon, permiso: "guardarPromocion" },
  { href: "/panel/fidelizacion/repite", label: "Repite", icon: WalletIcon, permiso: "guardarAjustesRepite" },
  { href: "/panel/fidelizacion/demo", label: "Piezas de ejemplo", icon: SquaresFourIcon, permiso: null },
]
export function useAccesoFidelizacion() {
  const panel = usePanel()
  return { ...panel, modules: restaurantModules(panel.restaurant) }
}
export function MarcoFidelizacion({ children }: { children: ReactNode }) {
  const acceso = useAccesoFidelizacion()
  const path = usePathname()
  const visibles = pestañas.filter((p) => p.permiso ? permitido(acceso, p.permiso) : permitido(acceso, "verCuentaFidelizacion") || permitido(acceso, "verTarjetaRepite"))
  const actual = pestañas.find((p) => p.href === path)
  const permitidoAqui = actual && visibles.includes(actual)
  return <>
    <PageHeading eyebrow={acceso.restaurant.name} title="Que apetezca volver" description="Puntos, premios y promociones para cuidar a quienes vuelven a tu mesa." />
    <nav aria-label="Fidelización" className="mb-6 flex gap-1 overflow-x-auto pb-1">{visibles.map(({ href, label, icon: Icon }) => <Button key={href} asChild variant={path === href ? "secondary" : "ghost"} className="min-h-11 shrink-0"><Link href={href} aria-current={path === href ? "page" : undefined}><Icon aria-hidden />{label}</Link></Button>)}</nav>
    {permitidoAqui ? children : <Notice title="Esta pantalla no está disponible para tu acceso">La configuración requiere ser propietario o encargado y tener el módulo activo. {visibles.length ? <Link className="underline" href={visibles[0]!.href}>Ver las opciones disponibles</Link> : null}</Notice>}
  </>
}
