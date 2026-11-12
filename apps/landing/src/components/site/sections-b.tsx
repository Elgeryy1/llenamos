import { useState } from "react"
import { ArrowRight, Check, Clock, EnvelopeSimple } from "@phosphor-icons/react"
import { BorderBeam } from "@/components/ui/border-beam"
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion"
import { cn } from "@/lib/utils"
import { COMING, CONTACT_EMAIL, CTA_SHORT, FAQ, INCLUDED, PILOT, PLANS, STEPS } from "@/content"
import { BookingMock, DayListMock } from "./demo-views"
import { PanelView } from "./panel-view"
import { Reveal, SectionHeading } from "./reveal"

export function Steps() {
  return (
    <section id="como-funciona" aria-labelledby="pasos-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <SectionHeading
        eyebrow="Cómo funciona"
        title={<span id="pasos-title">Tres pasos y a servir</span>}
        text="No te damos una cuenta vacía: nos cuentas cómo es tu sala y lo dejamos listo contigo."
      />
      <ol className="mt-16 grid gap-4 md:grid-cols-3">
        {STEPS.map((s, i) => (
          <Reveal as="li" key={s.n} delay={i * 120} className="relative rounded-2xl border border-white/10 bg-surface p-8">
            <span className="font-mono text-sm text-ember" aria-hidden="true">{s.n}</span>
            <h3 className="mt-6 text-xl font-semibold">{s.title}</h3>
            <p className="mt-3 text-sm text-dim">{s.text}</p>
          </Reveal>
        ))}
      </ol>
    </section>
  )
}

/** Lo que hace hoy Llenamos y lo que viene, sin fechas. */
export function Included() {
  return (
    <section id="incluye" aria-labelledby="incluye-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <SectionHeading
        eyebrow="Qué incluye"
        title={<span id="incluye-title">Lo que hace Llenamos hoy</span>}
        text="Esto es Llenamos Reservas, lo que ya puedes usar. Debajo, lo que viene después al mismo programa."
      />
      <Reveal className="mt-16">
        <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2 lg:grid-cols-3">
          {INCLUDED.map((f) => (
            <li key={f.title} className="flex gap-3">
              <Check weight="bold" aria-hidden="true" className="mt-1 size-4 shrink-0 text-ember" />
              <div>
                <h3 className="text-base font-semibold">{f.title}</h3>
                <p className="mt-1 text-sm text-dim">{f.text}</p>
              </div>
            </li>
          ))}
        </ul>
      </Reveal>

      <Reveal className="mt-16 rounded-2xl border border-white/10 bg-surface p-6 md:p-8">
        <h3 className="flex items-center gap-2 text-lg font-semibold">
          <Clock weight="duotone" aria-hidden="true" className="size-5 text-ember" />
          Próximamente
        </h3>
        <p className="mt-2 text-sm text-dim">Sin fechas: lo anunciamos cuando esté listo y probado.</p>
        <ul className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {COMING.map((c) => (
            <li key={c.title}>
              <p className="text-sm font-semibold">{c.title}</p>
              <p className="mt-1 text-sm text-dim">{c.text}</p>
            </li>
          ))}
        </ul>
      </Reveal>
    </section>
  )
}

/** Demostración con el restaurante inventado Taberna Lumbre. Sustituye a las opiniones. */
export function Demo() {
  const subject = encodeURIComponent("Quiero ver la demo de Llenamos")
  return (
    <section id="demo" aria-labelledby="demo-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <SectionHeading
        eyebrow="Demo"
        title={<span id="demo-title">Así se ve con Taberna Lumbre</span>}
        text="Taberna Lumbre es nuestro restaurante de demostración: así lo ve el cliente y así lo ve tu equipo."
      />
      <div className="mt-16 grid items-start gap-10 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Reveal>
          <h3 className="mb-4 text-center text-base font-semibold">El cliente reserva desde el móvil</h3>
          <PanelView id="movil">
            <BookingMock />
          </PanelView>
        </Reveal>
        <Reveal delay={120}>
          <h3 className="mb-4 text-center text-base font-semibold">El equipo ve las reservas del día</h3>
          <PanelView id="reservas">
            <DayListMock />
          </PanelView>
        </Reveal>
      </div>
      <Reveal className="mt-12 flex flex-col items-center gap-3 text-center">
        <a
          href={`mailto:${CONTACT_EMAIL}?subject=${subject}`}
          className="inline-flex min-h-11 items-center gap-2 rounded-full border border-white/15 px-5 py-2 text-base font-semibold text-foreground transition-all duration-700 ease-fluid outline-none hover:bg-white/5 focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink"
        >
          <EnvelopeSimple aria-hidden="true" className="size-5 text-ember" />
          Pídenos que te lo enseñemos
        </a>
        <p className="text-sm text-dim">Te escribimos desde {CONTACT_EMAIL} para enseñártelo con Taberna Lumbre.</p>
      </Reveal>
    </section>
  )
}

/** Por qué entrar ahora, sin prometer nada que no esté decidido. */
export function Pilot() {
  return (
    <section aria-labelledby="pilotos-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <SectionHeading
        eyebrow="Alta acompañada"
        title={<span id="pilotos-title">Te lo dejamos funcionando</span>}
        text="Montamos contigo la sala, los turnos y los mensajes antes de tu primer servicio, y estamos al otro lado cuando lo necesites."
      />
      <ul className="mt-16 grid gap-4 md:grid-cols-3">
        {PILOT.map((p, i) => (
          <Reveal as="li" key={p.title} delay={i * 120} className="rounded-2xl border border-white/10 bg-surface p-8">
            <h3 className="text-xl font-semibold">{p.title}</h3>
            <p className="mt-3 text-sm text-dim">{p.text}</p>
          </Reveal>
        ))}
      </ul>
      <Reveal className="mt-10 flex justify-center">
        <a
          href="#piloto"
          className="group inline-flex min-h-12 items-center gap-2 rounded-full bg-ember px-6 py-3 text-base font-semibold text-primary-foreground transition-all duration-700 ease-fluid outline-none hover:brightness-110 focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-ink active:scale-[0.98]"
        >
          {CTA_SHORT}
          <ArrowRight weight="bold" aria-hidden="true" className="size-4 transition-transform duration-700 ease-fluid group-hover:translate-x-1" />
        </a>
      </Reveal>
    </section>
  )
}

export function Pricing() {
  const [yearly, setYearly] = useState(true)
  return (
    <section id="precios" aria-labelledby="precios-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <SectionHeading
        eyebrow="Precios"
        title={<span id="precios-title">Una cuota fija, sin comisión por comensal</span>}
        text="Empiezas con 30 días gratis, sin tarjeta y sin permanencia. Precios sin IVA."
      />

      <Reveal className="mt-10 flex justify-center">
        <div role="group" aria-label="Forma de pago" className="inline-flex rounded-full border border-white/10 bg-surface p-1">
          {[
            { v: false, l: "Mensual" },
            { v: true, l: "Anual · un 20 % menos" },
          ].map((o) => (
            <button
              key={o.l}
              type="button"
              aria-pressed={yearly === o.v}
              onClick={() => setYearly(o.v)}
              className={cn(
                "min-h-11 rounded-full px-4 py-2 text-sm font-semibold transition-all duration-700 ease-fluid outline-none focus-visible:ring-2 focus-visible:ring-ember active:scale-[0.98]",
                yearly === o.v ? "bg-foreground text-ink" : "text-dim hover:text-foreground"
              )}
            >
              {o.l}
            </button>
          ))}
        </div>
      </Reveal>

      <div className="mt-12 grid items-start gap-4 md:grid-cols-3">
        {PLANS.map((p, i) => (
          <Reveal
            key={p.id}
            delay={i * 120}
            className={cn(
              "relative flex flex-col rounded-3xl border p-8",
              p.highlight ? "border-ember/40 bg-raised md:-mt-4 md:pb-12" : "border-white/10 bg-surface"
            )}
          >
            {p.highlight && (
              <>
                <span className="absolute top-8 right-8 rounded-full bg-ember/15 px-3 py-1 text-xs font-semibold text-ember">
                  Recomendado
                </span>
                <BorderBeam size={140} duration={9} colorFrom="#f0a35e" colorTo="#f4f1ea" borderWidth={1.5} />
              </>
            )}
            <h3 className="text-xl font-semibold">{p.name}</h3>
            <p className="mt-1 text-sm text-dim">{p.for}</p>
            <p className="mt-8 flex items-baseline gap-1">
              <span className="text-5xl font-semibold tracking-tight tabular-nums">{yearly ? p.yearly : p.monthly} €</span>
              <span className="text-sm text-dim">al mes</span>
            </p>
            <p className="mt-2 min-h-5 text-xs text-dim">
              {yearly ? `${p.yearly * 12} € al año, sin IVA` : "Sin IVA"}
            </p>
            <a
              href="#piloto"
              className={cn(
                "mt-8 inline-flex min-h-12 items-center justify-center rounded-full px-4 py-3 text-base font-semibold transition-all duration-700 ease-fluid outline-none focus-visible:ring-2 focus-visible:ring-ember focus-visible:ring-offset-2 focus-visible:ring-offset-ink active:scale-[0.98]",
                p.highlight
                  ? "bg-ember text-primary-foreground hover:brightness-110"
                  : "border border-white/15 text-foreground hover:bg-white/5"
              )}
            >
              {CTA_SHORT}
              <span className="sr-only"> con el plan {p.name}</span>
            </a>
            <ul className="mt-8 flex flex-col gap-3">
              {p.features.map((f) => (
                <li key={f} className="flex gap-3 text-sm text-foreground/90">
                  <Check weight="bold" aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-ember" />
                  {f}
                </li>
              ))}
            </ul>
            {p.soon.length > 0 && (
              <>
                <p className="mt-6 text-xs font-semibold text-dim">Próximamente</p>
                <ul className="mt-3 flex flex-col gap-3">
                  {p.soon.map((f) => (
                    <li key={f} className="flex gap-3 text-sm text-dim">
                      <Clock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
                      {f}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Reveal>
        ))}
      </div>
      <Reveal className="mt-8 text-center text-sm text-dim">
        ¿Tienes más locales o necesitas algo a medida?{" "}
        <a
          href={`mailto:${CONTACT_EMAIL}`}
          className="font-semibold text-foreground underline underline-offset-4 hover:text-ember"
        >
          Escríbenos
        </a>
        .
      </Reveal>
    </section>
  )
}

export function Faq() {
  return (
    <section id="preguntas" aria-labelledby="preguntas-title" className="mx-auto max-w-3xl px-4 py-24 md:py-32">
      <SectionHeading eyebrow="Preguntas" title={<span id="preguntas-title">Lo que nos preguntan antes de empezar</span>} />
      <Reveal className="mt-12">
        <Accordion className="rounded-2xl border border-white/10 bg-surface px-6">
          {FAQ.map((f) => (
            <AccordionItem key={f.q} value={f.q} className="border-white/10">
              <AccordionTrigger className="min-h-11 py-6 text-base font-semibold hover:no-underline hover:text-ember">
                {f.q}
              </AccordionTrigger>
              <AccordionContent className="pb-6 text-base text-dim">{f.a}</AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </Reveal>
    </section>
  )
}
