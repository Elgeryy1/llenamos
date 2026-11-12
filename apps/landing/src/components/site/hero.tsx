import { ArrowRight } from "@phosphor-icons/react"
import BackgroundPaths from "@/components/kokonutui/background-paths"
import { CTA, CTA_NOTE } from "@/content"
import { ContainerScroll } from "./container-scroll"
import { DashboardMock } from "./dashboard-mock"
import { PanelView } from "./panel-view"

export function Hero() {
  return (
    <section id="inicio" aria-labelledby="hero-title" className="relative overflow-x-clip">
      <BackgroundPaths
        className="min-h-[760px] items-start bg-ink pt-40 pb-24 text-ember dark:bg-ink dark:text-ember md:min-h-[820px] md:pt-48"
        count={45}
        angle={-9}
        speed={0.8}
      >
        <div className="relative z-10 mx-auto flex max-w-3xl flex-col items-center px-4 text-center text-foreground">
          <a
            href="#piloto"
            className="animate-in fade-in slide-in-from-bottom-4 group mb-8 inline-flex min-h-11 items-center gap-2 rounded-full border border-white/10 bg-white/5 py-1 pr-3 pl-1 text-sm text-dim backdrop-blur transition-all duration-700 ease-fluid outline-none hover:border-ember/40 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ember"
          >
            <span className="rounded-full bg-ember px-2 py-0.5 text-xs font-semibold text-primary-foreground">Nuevo</span>
            <span>Señal con tarjeta y confirmación por WhatsApp</span>
            <ArrowRight className="size-3 transition-transform duration-700 ease-fluid group-hover:translate-x-1" />
          </a>

          <h1
            id="hero-title"
            className="animate-in fade-in slide-in-from-bottom-8 text-hero max-w-[680px] text-4xl font-semibold tracking-tight duration-1000 sm:text-6xl md:text-7xl"
          >
            Llena cada turno
            <br />
            sin vivir al teléfono
          </h1>

          <p className="animate-in fade-in slide-in-from-bottom-8 mt-6 max-w-[680px] text-base text-dim delay-150 duration-1000 fill-mode-both md:text-lg">
            Las reservas de tu página, tu web, Instagram y el botón «Reservar» de tu ficha de Google, en un solo plano de
            sala. Llenamos las confirma por correo y WhatsApp y te deja pedir una señal con tarjeta para que no te fallen
            mesas.
          </p>

          <div className="animate-in fade-in slide-in-from-bottom-8 mt-10 flex flex-col items-center gap-3 delay-300 duration-1000 fill-mode-both">
            <a
              href="#piloto"
              className="group inline-flex min-h-12 items-center gap-2 rounded-full bg-ember px-6 py-3 text-base font-semibold text-primary-foreground shadow-[0_8px_32px_-8px_rgb(240_163_94/0.6)] transition-all duration-700 ease-fluid outline-none hover:-translate-y-0.5 hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-ink active:translate-y-px active:scale-[0.98]"
            >
              {CTA}
              <ArrowRight weight="bold" className="size-4 transition-transform duration-700 ease-fluid group-hover:translate-x-1" />
            </a>
            <p className="text-sm text-dim">{CTA_NOTE}</p>
          </div>

        </div>
      </BackgroundPaths>

      <div className="relative z-10 -mt-16 pb-24 md:-mt-40">
        <PanelView
          id="sala"
          captionClassName="px-4"
          frame={(content) => <ContainerScroll>{content}</ContainerScroll>}
        >
          <DashboardMock />
        </PanelView>
      </div>
    </section>
  )
}
