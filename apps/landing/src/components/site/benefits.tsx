import {
  ChatsCircle,
  CreditCard,
  HourglassMedium,
  SquaresFour,
  Star,
} from "@phosphor-icons/react"
import { useReducedMotion } from "motion/react"
import { AnimatedList } from "@/components/ui/animated-list"
import { BentoCard, BentoGrid } from "@/components/ui/bento-grid"
import { BorderBeam } from "@/components/ui/border-beam"
import { cn } from "@/lib/utils"
import { Reveal, SectionHeading } from "./reveal"

// Respuestas de clientes a la confirmación por WhatsApp (ejemplo). Llenamos entiende
// «Confirmar» y «Cancelar»; lo demás lo lee el restaurante.
const MESSAGES = [
  { name: "Lucía M.", text: "Confirmar", result: "Confirmada · 4 · 21:30", ok: true },
  { name: "Pau S.", text: "Cancelar", result: "Cancelada · mesa 6 libre", ok: false },
  { name: "Hana O.", text: "Confirmar", result: "Confirmada · 2 · 21:00", ok: true },
  { name: "Diego V.", text: "Confirmar", result: "Confirmada · 6 · 22:00", ok: true },
  { name: "Marina S.", text: "Confirmar", result: "Confirmada · 3 · 20:45", ok: true },
]

function WhatsAppFeed() {
  const reduce = useReducedMotion()
  const items = MESSAGES.map((m) => (
    <div key={m.name} className="w-full rounded-xl border border-white/10 bg-raised px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold text-foreground">{m.name}</span>
        <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs text-foreground">«{m.text}»</span>
      </div>
      <p className={cn("mt-1 text-sm", m.ok ? "text-sage" : "text-ember")}>{m.result}</p>
    </div>
  ))
  return (
    <div className="absolute inset-x-0 top-0 h-[62%] overflow-hidden px-4 pt-4 [mask-image:linear-gradient(to_bottom,#000_60%,transparent)]">
      {reduce ? (
        <div className="flex flex-col gap-2">{items}</div>
      ) : (
        <AnimatedList delay={1800} className="gap-2">
          {items}
        </AnimatedList>
      )}
    </div>
  )
}

const MINI: { c: number; r: number; w?: number; s: "a" | "b" | "c" }[] = [
  { c: 1, r: 1, s: "b" }, { c: 2, r: 1, s: "a" }, { c: 3, r: 1, w: 2, s: "b" }, { c: 5, r: 1, s: "c" },
  { c: 6, r: 1, s: "a" }, { c: 1, r: 2, w: 2, s: "a" }, { c: 3, r: 2, s: "c" }, { c: 4, r: 2, s: "b" },
  { c: 5, r: 2, w: 2, s: "b" }, { c: 1, r: 3, s: "c" }, { c: 2, r: 3, s: "b" }, { c: 3, r: 3, w: 2, s: "a" },
  { c: 5, r: 3, s: "b" }, { c: 6, r: 3, s: "c" },
]

function FloorPreview() {
  return (
    <div className="absolute inset-x-6 top-6 grid h-[52%] grid-cols-6 grid-rows-3 gap-3 transition-transform duration-1000 ease-fluid group-hover:scale-[1.03]">
      {MINI.map((t, i) => (
        <div
          key={i}
          style={{ gridColumn: `${t.c} / span ${t.w ?? 1}`, gridRow: t.r }}
          className={cn(
            "rounded-lg border",
            t.s === "a" && "border-sage/40 bg-sage/15",
            t.s === "b" && "border-ember/50 bg-ember/15",
            t.s === "c" && "border-white/10 bg-white/[0.03]"
          )}
        />
      ))}
    </div>
  )
}

function DepositPreview() {
  return (
    <div className="absolute inset-x-6 top-6 rounded-xl border border-white/10 bg-raised p-4">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">Señal por persona</span>
        <span className="relative inline-flex h-6 w-10 items-center rounded-full bg-ember p-0.5">
          <span className="ml-auto size-5 rounded-full bg-ink" />
        </span>
      </div>
      <p className="mt-4 font-mono text-3xl font-medium text-foreground">10,00 €</p>
      <p className="mt-1 text-xs text-dim">Desde grupos de 4 · cancelación gratis hasta 24 h antes</p>
      <p className="mt-3 text-xs text-dim">Cobro con tarjeta mediante Stripe</p>
      <BorderBeam size={90} duration={7} colorFrom="#f0a35e" colorTo="#8fc7a0" />
    </div>
  )
}

function WaitlistPreview() {
  const rows = [
    { n: "Jordi Puig", p: 2, s: "Avisado · mesa 7", on: true },
    { n: "Aitana Gil", p: 3, s: "En espera · 2.º", on: false },
    { n: "Samir Haddad", p: 2, s: "En espera · 3.º", on: false },
  ]
  return (
    <div className="absolute inset-x-6 top-6 flex flex-col gap-2">
      {rows.map((r) => (
        <div
          key={r.n}
          className={cn(
            "flex items-center justify-between rounded-xl border px-3 py-2 transition-all duration-700 ease-fluid",
            r.on ? "border-sage/40 bg-sage/10 group-hover:translate-x-1" : "border-white/10 bg-raised"
          )}
        >
          <span className="text-sm text-foreground">{r.n} · {r.p}</span>
          <span className={cn("text-xs", r.on ? "text-sage" : "text-dim")}>{r.s}</span>
        </div>
      ))}
    </div>
  )
}

function ReviewsPreview() {
  return (
    <div className="absolute inset-x-6 top-6 rounded-xl border border-white/10 bg-raised p-4">
      <p className="text-xs text-dim">Al día siguiente, por correo o WhatsApp</p>
      <p className="mt-2 text-sm text-foreground">
        Gracias por venir ayer a Taberna Lumbre, Lucía. Si te gustó, ¿nos dejas tu opinión en Google?
      </p>
      <div className="mt-3 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-ember px-3 py-1 text-xs font-semibold text-primary-foreground transition-transform duration-700 ease-fluid group-hover:-translate-y-0.5">
          <Star weight="fill" className="size-3" /> Escribir reseña
        </span>
      </div>
    </div>
  )
}

const FEATURES = [
  {
    Icon: SquaresFour,
    name: "Todas las reservas en un plano",
    description: "Tu página, tu web, Instagram, Google y las que apuntas por teléfono entran en la misma sala. Ves quién llega, dónde se sienta y qué mesas quedan libres.",
    href: "#como-funciona",
    cta: "Ver cómo se monta",
    className: "md:col-span-2",
    background: <FloorPreview />,
  },
  {
    Icon: ChatsCircle,
    name: "Confirma por correo y WhatsApp",
    description: "Un recordatorio el día antes. El cliente responde «Confirmar» o «Cancelar» y la reserva cambia sola.",
    href: "#preguntas",
    cta: "Qué hace falta para WhatsApp",
    className: "md:col-span-1",
    background: <WhatsAppFeed />,
  },
  {
    Icon: CreditCard,
    name: "Señal contra los no presentados",
    description: "Pide una señal con tarjeta a los grupos que elijas, con tu política de cancelación a la vista al reservar.",
    href: "#preguntas",
    cta: "Cómo funciona la señal",
    className: "md:col-span-1",
    background: <DepositPreview />,
  },
  {
    Icon: HourglassMedium,
    name: "Lista de espera que se mueve sola",
    description: "Si alguien cancela, Llenamos avisa a quien espera y puede quedarse la mesa desde el enlace del mensaje.",
    href: "#como-funciona",
    cta: "Ver los pasos",
    className: "md:col-span-1",
    background: <WaitlistPreview />,
  },
  {
    Icon: Star,
    name: "Pide la reseña sin pensar en ello",
    description: "Al día siguiente de la visita sale un mensaje amable con el enlace a tu ficha de Google.",
    href: "#demo",
    cta: "Ver la demo",
    className: "md:col-span-1",
    background: <ReviewsPreview />,
  },
]

export function Benefits() {
  return (
    <section id="producto" aria-labelledby="producto-title" className="mx-auto max-w-6xl px-4 py-24 md:py-32">
      <SectionHeading
        eyebrow="Producto"
        title={<span id="producto-title">Todo lo que pasa en tu sala, en una pantalla</span>}
        text="Cinco piezas que trabajan juntas para que cada reserva acabe en una mesa ocupada."
      />
      <Reveal className="mt-16">
        <BentoGrid className="md:grid-cols-3">
          {FEATURES.map((f) => (
            <BentoCard key={f.name} {...f} />
          ))}
        </BentoGrid>
      </Reveal>
    </section>
  )
}
