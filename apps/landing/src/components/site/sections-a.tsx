import { CalendarX, ChatsCircle, PhoneCall, ArrowBendDownRight } from "@phosphor-icons/react"
import { Marquee } from "@/components/ui/marquee"
import { TextReveal } from "@/components/ui/text-reveal"
import { CHANNELS, PAINS } from "@/content"
import { Reveal } from "./reveal"

/** Franja con los canales por los que entran las reservas. */
export function Channels() {
  return (
    <section aria-labelledby="canales-title" className="py-16">
      <h2 id="canales-title" className="px-4 text-center text-sm text-dim">
        Todas tus reservas entran en el mismo plano
      </h2>
      {/* Para lectores de pantalla, la lista una sola vez; el carrusel es decorativo. */}
      <ul className="sr-only">
        {CHANNELS.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
      <div
        aria-hidden="true"
        className="relative mt-8 [mask-image:linear-gradient(90deg,transparent,#000_12%,#000_88%,transparent)]"
      >
        <Marquee pauseOnHover className="[--duration:48s] [--gap:3rem]">
          {CHANNELS.map((c) => (
            <span key={c} className="flex items-center gap-2 text-xl font-semibold tracking-tight whitespace-nowrap text-foreground/80">
              <ArrowBendDownRight className="size-5 text-ember" weight="bold" />
              {c}
            </span>
          ))}
        </Marquee>
      </div>
    </section>
  )
}

const PAIN_ICONS = [CalendarX, PhoneCall, ChatsCircle]

/** El problema, sin cifras inventadas. */
export function Problem() {
  return (
    <section aria-labelledby="problema-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <Reveal className="mx-auto max-w-2xl text-center">
        <p className="font-mono text-xs tracking-widest text-ember uppercase">El problema</p>
        <h2 id="problema-title" className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">
          Cada sábado se te escapan mesas
        </h2>
        <p className="mt-6 text-base text-dim md:text-lg">
          Reservas por cuatro canales, una libreta junto al teléfono y clientes que no avisan. Lo conoce cualquiera que
          haya llevado una sala.
        </p>
      </Reveal>

      <ul className="mt-16 grid gap-4 md:grid-cols-3">
        {PAINS.map((p, i) => {
          const Icon = PAIN_ICONS[i % PAIN_ICONS.length]
          return (
            <Reveal as="li" key={p.title} delay={i * 120} className="rounded-2xl border border-white/10 bg-surface p-8">
              <Icon weight="duotone" className="size-10 text-ember" aria-hidden="true" />
              <h3 className="mt-6 text-2xl font-semibold tracking-tight">{p.title}</h3>
              <p className="mt-3 text-sm text-dim">{p.text}</p>
            </Reveal>
          )
        })}
      </ul>
    </section>
  )
}

/** Frase grande que se enciende palabra a palabra al bajar. */
export function Tagline() {
  return (
    <section aria-label="Lo que hace Llenamos" className="relative">
      <TextReveal>
        Tú cocinas y atiendes la sala. Llenamos se encarga de que cada reserva acabe en una mesa ocupada.
      </TextReveal>
    </section>
  )
}
