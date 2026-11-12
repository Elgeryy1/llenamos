import { useId, useState, type FormEvent } from "react"
import { EnvelopeSimple, WarningCircle } from "@phosphor-icons/react"
import BackgroundPaths from "@/components/kokonutui/background-paths"
import { ShimmerButton } from "@/components/ui/shimmer-button"
import { CONTACT_EMAIL, CTA, CTA_NOTE, NAV } from "@/content"
import { pilotMailto, type PilotFields as Fields } from "@/lib/pilot"
import { Logo } from "./logo"
import { Reveal } from "./reveal"

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

type Errors = Partial<Record<keyof Fields, string>>

/** Llamada final: solicitud de alta. */
export function FinalCta() {
  const id = useId()
  const [fields, setFields] = useState<Fields>({ local: "", city: "", email: "", phone: "" })
  const [error, setError] = useState<Errors>({})
  const [href, setHref] = useState<string | null>(null)

  const set = (k: keyof Fields) => (v: string) => setFields((f) => ({ ...f, [k]: v }))

  function submit(e: FormEvent) {
    e.preventDefault()
    const next: Errors = {}
    if (!fields.local.trim()) next.local = "Escribe el nombre de tu restaurante."
    if (!fields.city.trim()) next.city = "Escribe la ciudad."
    if (!fields.email.trim()) next.email = "Escribe tu correo para que podamos contestarte."
    else if (!EMAIL.test(fields.email.trim())) next.email = "Ese correo no parece válido. Revisa que tenga @ y dominio."
    if (fields.phone.trim() && !/^[+\d][\d\s().-]{6,}$/.test(fields.phone.trim()))
      next.phone = "Ese teléfono no parece válido. Escribe solo números, espacios o un + delante."
    setError(next)
    const first = (Object.keys(next) as (keyof Fields)[])[0]
    if (first) {
      document.getElementById(`${id}-${first}`)?.focus()
      return
    }
    const link = pilotMailto(fields)
    setHref(link)
    window.location.href = link
  }

  return (
    <section id="piloto" aria-labelledby="piloto-title" className="px-4 py-24 md:py-32">
      <Reveal className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/10 bg-raised px-6 py-16 text-center md:px-16 md:py-24">
        <BackgroundPaths className="absolute inset-0 min-h-0 bg-transparent text-ember opacity-50" count={30} angle={10} speed={0.5} interactive={false}>
          {null}
        </BackgroundPaths>
        <h2 id="piloto-title" className="text-hero relative mx-auto max-w-[680px] text-3xl font-semibold tracking-tight sm:text-4xl md:text-6xl">
          Tu próximo sábado,
          <br />
          con la sala llena
        </h2>
        <p className="relative mx-auto mt-6 max-w-[560px] text-base text-dim md:text-lg">
          Déjanos tus datos. Te escribimos, montamos contigo la sala y los turnos, y empiezas tus 30 días gratis.
        </p>

        <form onSubmit={submit} noValidate className="relative mx-auto mt-10 flex max-w-xl flex-col gap-3 text-left">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field id={`${id}-local`} label="Nombre del restaurante" value={fields.local} onChange={set("local")} error={error.local} autoComplete="organization" />
            <Field id={`${id}-city`} label="Ciudad" value={fields.city} onChange={set("city")} error={error.city} autoComplete="address-level2" />
            <Field id={`${id}-email`} label="Correo" type="email" value={fields.email} onChange={set("email")} error={error.email} autoComplete="email" />
            <Field id={`${id}-phone`} label="Teléfono (opcional)" type="tel" value={fields.phone} onChange={set("phone")} error={error.phone} autoComplete="tel" />
          </div>
          <ShimmerButton
            type="submit"
            background="#f0a35e"
            shimmerColor="#fff7ec"
            className="mt-2 min-h-12 w-full border-ember/40 px-6 py-3 text-base font-semibold text-primary-foreground transition-all duration-700 ease-fluid focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 focus-visible:ring-offset-raised focus-visible:outline-none"
          >
            <span className="relative z-10 flex items-center gap-2">
              <EnvelopeSimple aria-hidden="true" className="size-5" />
              {CTA}
            </span>
          </ShimmerButton>
          <p className="text-center text-sm text-dim">{CTA_NOTE}</p>
          <p className="text-center text-sm text-dim">
            Al pulsar se abre tu programa de correo con un mensaje para {CONTACT_EMAIL} ya escrito. Esta web no envía ni
            guarda nada: solo nos llega si tú lo envías.
          </p>
        </form>

        <div role="status" aria-live="polite" className="relative mx-auto max-w-xl">
          {href && (
            <div className="mt-6 rounded-2xl border border-sage/30 bg-sage/10 p-4 text-left text-sm text-foreground">
              <p className="font-semibold">Mensaje preparado. Envíalo desde tu correo.</p>
              <p className="mt-2 text-dim">
                Cuando nos llegue, te contestamos desde {CONTACT_EMAIL} para conocer tu restaurante y acordar cuándo lo
                montamos. Si no se ha abierto tu programa de correo,{" "}
                <a href={href} className="font-semibold text-foreground underline underline-offset-4 hover:text-ember">
                  ábrelo desde aquí
                </a>{" "}
                o escríbenos a{" "}
                <a href={`mailto:${CONTACT_EMAIL}`} className="font-semibold text-foreground underline underline-offset-4 hover:text-ember">
                  {CONTACT_EMAIL}
                </a>
                .
              </p>
            </div>
          )}
        </div>
      </Reveal>
    </section>
  )
}

function Field({
  id,
  label,
  value,
  onChange,
  error,
  type = "text",
  ...rest
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  error?: string
  type?: string
  autoComplete?: string
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-sm font-semibold text-foreground">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : undefined}
        className="h-12 rounded-xl border border-white/15 bg-ink px-4 text-base text-foreground transition-all duration-700 ease-fluid outline-none hover:border-white/25 focus:border-ember focus:ring-2 focus:ring-ember/40 aria-invalid:border-destructive"
        {...rest}
      />
      {error && (
        <p id={`${id}-err`} className="flex items-center gap-1 text-sm text-destructive">
          <WarningCircle aria-hidden="true" className="size-4 shrink-0" /> {error}
        </p>
      )}
    </div>
  )
}

const FOOT_LINK =
  "inline-flex min-h-11 items-center rounded-md text-sm text-dim transition-colors duration-700 ease-fluid outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ember"

export function Footer() {
  return (
    <footer className="overflow-x-clip border-t border-white/10 px-4 pt-16 pb-8">
      <div className="mx-auto grid max-w-6xl gap-12 md:grid-cols-4">
        <div className="md:col-span-2">
          <Logo by />
          <p className="mt-4 max-w-sm text-sm text-dim">
            Reservas y sala para restaurantes, hecho por{" "}
            <a href="https://logiqd.me" className="text-foreground underline underline-offset-4 hover:text-ember">
              LogiQD
            </a>
            .
          </p>
          <p className="mt-2 text-sm text-dim">
            <a href={`mailto:${CONTACT_EMAIL}`} className={FOOT_LINK}>
              {CONTACT_EMAIL}
            </a>
          </p>
        </div>
        <nav aria-label="Pie: producto">
          <p className="text-sm font-semibold">Producto</p>
          <ul className="mt-2 flex flex-col">
            {NAV.map((n) => (
              <li key={n.id}>
                <a href={`#${n.id}`} className={FOOT_LINK}>
                  {n.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <nav aria-label="Pie: legal">
          <p className="text-sm font-semibold">Legal</p>
          <ul className="mt-2 flex flex-col">
            <li><a href="/legal.html#aviso-legal" className={FOOT_LINK}>Aviso legal</a></li>
            <li><a href="/legal.html#privacidad" className={FOOT_LINK}>Privacidad</a></li>
            <li><a href="/legal.html#cookies" className={FOOT_LINK}>Cookies</a></li>
          </ul>
        </nav>
      </div>

      <p
        aria-hidden="true"
        className="mx-auto mt-16 max-w-6xl text-center text-[22vw] leading-none sm:text-8xl font-semibold tracking-tighter text-white/[0.06] select-none md:text-9xl"
      >
        llenamos
      </p>

      <div className="mx-auto mt-8 flex max-w-6xl flex-col gap-2 border-t border-white/10 pt-8 text-xs text-dim md:flex-row md:justify-between">
        <p>© 2026 LogiQD</p>
        <p>Hecho por LogiQD para la hostelería</p>
      </div>
    </footer>
  )
}
