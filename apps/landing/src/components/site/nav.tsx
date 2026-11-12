import { useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { CTA_SHORT, NAV } from "@/content"
import { Logo } from "./logo"
import { Access } from "./access"

/** Menú en forma de píldora de cristal flotante. En móvil se abre a pantalla completa. */
export function Nav() {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState<string>("")

  // Marca en el menú la sección que se está viendo.
  useEffect(() => {
    const sections = NAV.map((n) => document.getElementById(n.id)).filter(Boolean) as HTMLElement[]
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) if (e.isIntersecting) setActive(e.target.id)
      },
      { rootMargin: "-45% 0px -50% 0px" }
    )
    sections.forEach((s) => io.observe(s))
    return () => io.disconnect()
  }, [])

  // Con el menú abierto no se desplaza la página y Escape lo cierra.
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : ""
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false)
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [open])

  return (
    <>
      <header className="fixed inset-x-0 top-0 z-50 flex justify-center px-4">
        <nav
          aria-label="Principal"
          className="mt-6 flex w-full max-w-max items-center gap-2 rounded-full border border-white/10 bg-ink/60 p-2 pl-4 shadow-2xl shadow-black/40 backdrop-blur-xl"
        >
          <a
            href="#inicio"
            className="mr-2 flex min-h-11 items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ember"
            aria-label="Llenamos, ir al inicio"
          >
            <Logo by />
          </a>

          <ul className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <li key={n.id}>
                <a
                  href={`#${n.id}`}
                  aria-current={active === n.id ? "location" : undefined}
                  className={cn(
                    "inline-flex min-h-11 items-center rounded-full px-3 py-2 text-sm text-dim transition-all duration-700 ease-fluid outline-none hover:bg-white/5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ember",
                    active === n.id && "bg-white/10 text-foreground"
                  )}
                >
                  {n.label}
                </a>
              </li>
            ))}
          </ul>

          <a
            href="#piloto"
            className="ml-2 hidden min-h-11 items-center rounded-full bg-ember px-4 py-2 text-sm font-semibold text-primary-foreground transition-all duration-700 ease-fluid outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white active:scale-[0.98] sm:inline-flex"
          >
            {CTA_SHORT}
          </a>

          <Access />

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls="menu-movil"
            aria-label={open ? "Cerrar menú" : "Abrir menú"}
            className="relative z-50 ml-1 size-11 rounded-full outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ember lg:hidden"
          >
            <span
              className={cn(
                "absolute top-1/2 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-foreground transition-all duration-700 ease-fluid",
                open ? "-translate-y-1/2 rotate-45" : "-translate-y-[4px]"
              )}
            />
            <span
              className={cn(
                "absolute top-1/2 left-1/2 h-0.5 w-4 -translate-x-1/2 rounded-full bg-foreground transition-all duration-700 ease-fluid",
                open ? "-translate-y-1/2 -rotate-45" : "translate-y-[2px]"
              )}
            />
          </button>
        </nav>
      </header>

      <div
        id="menu-movil"
        className={cn(
          "fixed inset-0 z-40 flex flex-col justify-center bg-black/80 px-8 backdrop-blur-3xl transition-all duration-700 ease-fluid lg:hidden",
          open ? "visible opacity-100" : "invisible opacity-0"
        )}
        aria-hidden={!open}
        inert={!open}
      >
        <ul className="flex flex-col gap-4">
          {NAV.map((n, i) => (
            <li key={n.id} className="overflow-hidden">
              <a
                href={`#${n.id}`}
                tabIndex={open ? 0 : -1}
                onClick={() => setOpen(false)}
                style={{ transitionDelay: open ? `${100 + i * 50}ms` : "0ms" }}
                className={cn(
                  "block text-4xl font-semibold tracking-tight transition-all duration-700 ease-fluid outline-none focus-visible:text-ember focus-visible:underline focus-visible:underline-offset-8",
                  open ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0",
                  active === n.id ? "text-ember" : "text-foreground"
                )}
              >
                {n.label}
              </a>
            </li>
          ))}
        </ul>
        <a
          href="#piloto"
          tabIndex={open ? 0 : -1}
          onClick={() => setOpen(false)}
          style={{ transitionDelay: open ? "400ms" : "0ms" }}
          className={cn(
            "mt-12 inline-flex min-h-12 w-max items-center rounded-full bg-ember px-6 py-3 text-base font-semibold text-primary-foreground transition-all duration-700 ease-fluid outline-none focus-visible:ring-2 focus-visible:ring-white",
            open ? "translate-y-0 opacity-100" : "translate-y-12 opacity-0"
          )}
        >
          {CTA_SHORT}
        </a>
      </div>
    </>
  )
}
