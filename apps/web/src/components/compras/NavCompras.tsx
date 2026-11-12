"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/cn"

const TABS = [
  { href: "/panel/compras", label: "Pedidos" },
  { href: "/panel/compras/proveedores", label: "Proveedores y formatos" },
] as const

/** Dos vistas de Compras como enlaces: la dirección dice dónde estás y atrás vuelve donde estabas. */
export function NavCompras() {
  const pathname = usePathname()
  return (
    <nav aria-label="Compras" className="mb-5 flex gap-1 border-b">
      {TABS.map((t) => {
        const activa = t.href === "/panel/compras" ? pathname === t.href : pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={activa ? "page" : undefined}
            className={cn(
              "-mb-px inline-flex min-h-10 items-center border-b-2 px-3 text-sm font-medium transition-colors pointer-coarse:min-h-12",
              activa ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </nav>
  )
}
