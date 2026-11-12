import { useEffect, useRef } from "react"

if (import.meta.env.PROD && !import.meta.env.VITE_APP_URL) throw new Error("Configura VITE_APP_URL para publicar la presentación.")
const appOrigin = new URL(import.meta.env.VITE_APP_URL || "http://localhost:3000")
if (appOrigin.protocol !== "https:" && !(appOrigin.protocol === "http:" && ["localhost", "127.0.0.1"].includes(appOrigin.hostname))) throw new Error("VITE_APP_URL debe usar HTTPS (HTTP solo en desarrollo local).")

/** Las entradas indican el destino; los permisos se comprueban al iniciar sesión. */
export function Access() {
  const menu = useRef<HTMLDetailsElement>(null)
  useEffect(() => {
    const close = (event: PointerEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) menu.current.open = false }
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && menu.current?.open && menu.current.contains(document.activeElement)) {
        menu.current.open = false; menu.current.querySelector("summary")?.focus()
      }
    }
    document.addEventListener("pointerdown", close)
    document.addEventListener("keydown", escape)
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape) }
  }, [])
  return <details ref={menu} className="relative">
    <summary className="flex min-h-11 cursor-pointer list-none items-center rounded-full px-3 text-sm font-semibold outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ember">Acceder</summary>
    <div className="absolute right-0 top-full mt-3 w-60 rounded-2xl border border-white/15 bg-ink p-2 shadow-2xl">
      {[["propietario", "Soy propietario", "/panel"], ["trabajador", "Soy trabajador", "/panel"], ["logiqd", "Equipo LogiQD", "/logiqd"]].map(([entry, label, next]) => {
        const url = new URL("/entrar", appOrigin); url.searchParams.set("acceso", entry!); url.searchParams.set("siguiente", next!)
        return <a key={entry} href={url.href} className="flex min-h-11 items-center rounded-xl px-3 text-sm outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-ember">{label}</a>
      })}
    </div>
  </details>
}
