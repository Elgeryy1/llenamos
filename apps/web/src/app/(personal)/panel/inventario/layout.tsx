import { MarcoInventario } from "@/components/inventario/Marco"

export default function InventarioLayout({ children }: LayoutProps<"/panel/inventario">) {
  return <MarcoInventario>{children}</MarcoInventario>
}
