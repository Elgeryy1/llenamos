import { useEffect, useState } from "react"
import {
  CalendarBlank,
  CheckCircle,
  Clock,
  MagnifyingGlass,
  UsersThree,
  WhatsappLogo,
} from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { LogoMark } from "./logo"

type State = "libre" | "reservada" | "sentada" | "confirmar"

type Table = {
  id: number
  x: number
  y: number
  w: number
  h: number
  round?: boolean
  seats: number
  state: State
  who?: string
}

// Plano de una sala de 112 cubiertos. Posiciones en % del plano.
const TABLES: Table[] = [
  { id: 1, x: 4, y: 8, w: 13, h: 18, seats: 4, state: "sentada", who: "Vidal" },
  { id: 2, x: 21, y: 8, w: 13, h: 18, seats: 4, state: "reservada", who: "Ochoa 21:30" },
  { id: 3, x: 38, y: 8, w: 13, h: 18, seats: 4, state: "sentada", who: "Mir" },
  { id: 4, x: 55, y: 8, w: 22, h: 18, seats: 8, state: "confirmar", who: "Cena empresa" },
  { id: 5, x: 82, y: 8, w: 14, h: 18, round: true, seats: 2, state: "libre" },
  { id: 6, x: 4, y: 38, w: 13, h: 18, round: true, seats: 2, state: "reservada", who: "Sanz 22:00" },
  { id: 7, x: 21, y: 38, w: 13, h: 18, round: true, seats: 2, state: "libre" },
  { id: 8, x: 38, y: 38, w: 22, h: 18, seats: 6, state: "sentada", who: "Gallardo" },
  { id: 9, x: 64, y: 38, w: 13, h: 18, round: true, seats: 2, state: "sentada", who: "Pérez" },
  { id: 10, x: 82, y: 38, w: 14, h: 18, round: true, seats: 2, state: "reservada", who: "Kaur 21:45" },
  { id: 11, x: 4, y: 70, w: 22, h: 20, seats: 6, state: "reservada", who: "Ibarra 22:15" },
  { id: 12, x: 30, y: 70, w: 13, h: 20, seats: 4, state: "libre" },
  { id: 13, x: 47, y: 70, w: 13, h: 20, seats: 4, state: "sentada", who: "Roig" },
]

// Cambios que van pasando en directo para que el panel respire.
const LIVE: { id: number; to: State; who?: string; note: string }[] = [
  { id: 4, to: "reservada", note: "Cena empresa confirmó por WhatsApp · 8 personas" },
  { id: 2, to: "sentada", note: "Ochoa ha llegado · mesa 2" },
  { id: 7, to: "reservada", who: "Lista espera", note: "Mesa 7 libre: Jordi, de la lista de espera, la ha aceptado" },
  { id: 6, to: "sentada", note: "Sanz ha llegado · mesa 6" },
]

const STYLE: Record<State, string> = {
  libre: "border-white/10 bg-white/[0.03] text-dim",
  reservada: "border-ember/60 bg-ember/15 text-ember",
  sentada: "border-sage/50 bg-sage/15 text-sage",
  confirmar: "border-dashed border-ember/70 bg-transparent text-ember",
}

const ARRIVALS = [
  { time: "21:30", name: "Marta Ochoa", pax: 4, table: 2, ok: true },
  { time: "21:45", name: "Harpreet Kaur", pax: 2, table: 10, ok: true },
  { time: "22:00", name: "Óscar Sanz", pax: 2, table: 6, ok: true },
  { time: "22:00", name: "Cena empresa Lumen", pax: 8, table: 4, ok: false },
  { time: "22:15", name: "Jon Ibarra", pax: 6, table: 11, ok: true },
]

export function DashboardMock() {
  const [tables, setTables] = useState(TABLES)
  const [step, setStep] = useState(-1)

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return
    const t = window.setInterval(() => {
      setStep((s) => {
        const next = s + 1
        if (next >= LIVE.length) {
          setTables(TABLES)
          return -1
        }
        const c = LIVE[next]
        setTables((ts) => ts.map((tb) => (tb.id === c.id ? { ...tb, state: c.to, who: c.who ?? tb.who } : tb)))
        return next
      })
    }, 2600)
    return () => window.clearInterval(t)
  }, [])

  const seated = tables.filter((t) => t.state === "sentada").reduce((a, t) => a + t.seats, 0) + 41
  const pending = tables.filter((t) => t.state === "confirmar").length + 2

  return (
    <div className="flex aspect-[3/4] flex-col text-left select-none sm:aspect-[16/10]" aria-label="Ilustración del panel de Llenamos: plano de la sala en directo con mesas libres, reservadas y sentadas, y las próximas llegadas" role="img">
      {/* Barra superior */}
      <div className="flex items-center gap-3 border-b border-white/5 px-4 py-3">
        <LogoMark className="size-5" />
        <div className="flex items-center gap-2 text-sm text-foreground">
          <CalendarBlank className="size-4 text-dim" />
          <span className="font-medium">Sábado 14 nov</span>
        </div>
        <div className="hidden rounded-lg border border-white/10 p-0.5 text-xs sm:flex">
          <span className="rounded-md px-2 py-1 text-dim">Comida</span>
          <span className="rounded-md bg-white/10 px-2 py-1 text-foreground">Cena</span>
        </div>
        <div className="ml-auto hidden items-center gap-2 rounded-lg border border-white/10 px-3 py-1 text-xs text-dim md:flex">
          <MagnifyingGlass className="size-3" /> Buscar cliente
        </div>
        <span className="ml-auto flex items-center gap-2 text-xs text-sage md:ml-0">
          <span className="relative flex size-2">
            <span className="absolute inline-flex size-full animate-ping rounded-full bg-sage opacity-60" />
            <span className="relative inline-flex size-2 rounded-full bg-sage" />
          </span>
          En directo
        </span>
        <span className="rounded border border-white/10 px-1.5 py-0.5 text-xs text-dim">Ejemplo</span>
      </div>

      {/* Indicadores */}
      <div className="grid grid-cols-2 gap-2 px-4 pt-4 md:grid-cols-4">
        <Kpi label="Cubiertos" value={`${seated}`} extra="/ 112" />
        <div className="hidden md:block"><Kpi label="Reservas" value="31" extra="hoy" /></div>
        <div className="hidden md:block"><Kpi label="Por confirmar" value={`${pending}`} tone="ember" /></div>
        <Kpi label="Señales cobradas" value="412,50 €" tone="sage" />
      </div>

      <div className="flex min-h-0 flex-1 gap-4 p-4">
        {/* Plano */}
        <div className="relative min-h-0 flex-1 rounded-xl border border-white/5 bg-[#181818]">
          <span className="absolute top-2 left-3 font-mono text-xs text-dim">Sala principal</span>
          <span className="absolute right-3 bottom-2 hidden font-mono text-xs text-dim sm:block">Terraza →</span>
          <div className="absolute inset-x-2 top-8 bottom-2 sm:inset-x-3">
            {tables.map((t) => (
              <div
                key={t.id}
                className={cn(
                  "absolute flex flex-col items-center justify-center border px-1 text-center transition-all duration-700 ease-fluid",
                  t.round ? "rounded-full" : "rounded-lg",
                  STYLE[t.state]
                )}
                style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
              >
                <span className="font-mono text-xs leading-none font-medium">{t.id}</span>
                {t.who && t.state !== "libre" && (
                  <span className="mt-1 hidden max-w-full truncate text-xs leading-none opacity-80 lg:block">{t.who}</span>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Próximas llegadas */}
        <div className="hidden w-64 shrink-0 flex-col gap-2 md:flex">
          <p className="text-xs font-medium text-dim">Próximas llegadas</p>
          {ARRIVALS.map((a) => (
            <div key={a.name} className="flex items-center gap-3 rounded-lg border border-white/5 bg-[#181818] px-3 py-2">
              <span className="font-mono text-xs text-dim">{a.time}</span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium text-foreground">{a.name}</p>
                <p className="flex items-center gap-1 text-xs text-dim">
                  <UsersThree className="size-3" /> {a.pax} · mesa {a.table}
                </p>
              </div>
              {a.ok ? (
                <CheckCircle weight="fill" className="size-4 text-sage" aria-label="Confirmada" />
              ) : (
                <Clock className="size-4 text-ember" aria-label="Por confirmar" />
              )}
            </div>
          ))}
          <div className="mt-auto flex items-center gap-2 text-xs text-dim">
            <Legend className="bg-sage/60" /> Sentada
            <Legend className="bg-ember/60" /> Reservada
            <Legend className="border border-dashed border-ember bg-transparent" /> Pendiente
          </div>
        </div>
      </div>

      {/* Aviso en directo */}
      <div className="pointer-events-none relative h-0">
        <div
          key={step}
          className={cn(
            "absolute right-8 bottom-8 left-8 flex items-center sm:right-auto sm:max-w-xs gap-2 rounded-xl border border-white/10 bg-raised/95 px-3 py-2 text-xs text-foreground shadow-xl backdrop-blur",
            "animate-in fade-in slide-in-from-bottom-4 duration-700",
            step < 0 && "hidden"
          )}
        >
          <WhatsappLogo weight="fill" className="size-4 shrink-0 text-sage" />
          {step >= 0 && LIVE[step].note}
        </div>
      </div>
    </div>
  )
}

function Kpi({ label, value, extra, tone }: { label: string; value: string; extra?: string; tone?: "ember" | "sage" }) {
  return (
    <div className="rounded-lg border border-white/5 bg-[#181818] px-3 py-2">
      <p className="text-xs text-dim">{label}</p>
      <p
        className={cn(
          "mt-1 font-mono text-lg font-medium tabular-nums",
          tone === "ember" && "text-ember",
          tone === "sage" && "text-sage"
        )}
      >
        {value}
        {extra && <span className="ml-1 text-xs text-dim">{extra}</span>}
      </p>
    </div>
  )
}

function Legend({ className }: { className?: string }) {
  return <span className={cn("ml-1 inline-block size-2 rounded-sm first:ml-0", className)} />
}
