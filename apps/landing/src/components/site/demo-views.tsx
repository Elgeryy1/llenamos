// Ilustraciones de la sección «Demo», con datos de ejemplo de Taberna Lumbre
// (restaurante inventado). Siguen las pantallas de `docs/diseno/`: Reserva.dc.html y
// Main.dc.html. Cuando haya capturas reales, se cambian en `src/captures.ts`.
import { CalendarBlank, Clock, UsersThree } from "@phosphor-icons/react"
import { cn } from "@/lib/utils"
import { LogoMark } from "./logo"

const SIZES = ["1", "2", "3", "4", "5", "6", "7", "8+"]
const DAYS = [
  { dow: "hoy", num: 9 },
  { dow: "mar", num: 10 },
  { dow: "mié", num: 11 },
  { dow: "jue", num: 12 },
  { dow: "vie", num: 13 },
]
const TIMES = [
  { t: "20:30", free: true },
  { t: "20:45", free: false },
  { t: "21:00", free: true },
  { t: "21:15", free: true },
  { t: "21:30", free: false },
  { t: "21:45", free: true },
]

function Chip({ on, off, children, className }: { on?: boolean; off?: boolean; children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        "flex items-center justify-center rounded-lg border font-mono text-sm",
        on && "border-ember bg-ember text-primary-foreground",
        !on && !off && "border-white/10 bg-surface text-foreground",
        off && "border-white/10 bg-transparent text-dim line-through",
        className
      )}
    >
      {children}
    </span>
  )
}

/** Página de reservas del restaurante en el móvil. */
export function BookingMock() {
  return (
    <div
      role="img"
      aria-label="Ilustración de la página de reservas de Taberna Lumbre en un móvil: el cliente elige 2 personas, el martes 10 y las 21:00"
      className="mx-auto w-full max-w-[320px] rounded-[2.5rem] border border-white/10 bg-raised p-2 select-none"
    >
      <div className="overflow-hidden rounded-[2rem] bg-ink px-4 pt-6 pb-4 text-left">
        <div className="flex items-center gap-3">
          <span className="flex size-10 items-center justify-center rounded-xl bg-ember font-semibold text-primary-foreground">TL</span>
          <div>
            <p className="text-base font-semibold">Taberna Lumbre</p>
            <p className="text-xs text-dim">Cocina de brasa · Barcelona</p>
          </div>
        </div>

        <p className="mt-6 text-xs font-semibold text-dim">Personas</p>
        <div className="mt-2 grid grid-cols-8 gap-1">
          {SIZES.map((s) => (
            <Chip key={s} on={s === "2"} className="h-9 text-xs">
              {s}
            </Chip>
          ))}
        </div>

        <p className="mt-5 text-xs font-semibold text-dim">Día</p>
        <div className="mt-2 grid grid-cols-5 gap-1">
          {DAYS.map((d) => (
            <Chip key={d.num} on={d.num === 10} className="h-12 flex-col gap-0.5">
              <span className="font-sans text-xs">{d.dow}</span>
              <span>{d.num}</span>
            </Chip>
          ))}
        </div>

        <p className="mt-5 text-xs font-semibold text-dim">Hora · cena</p>
        <div className="mt-2 grid grid-cols-3 gap-1">
          {TIMES.map((h) => (
            <Chip key={h.t} on={h.t === "21:00"} off={!h.free} className="h-9">
              {h.t}
            </Chip>
          ))}
        </div>

        <p className="mt-4 text-xs text-dim">¿No ves tu hora? Apúntate a la lista de espera y te avisamos si se libera una mesa.</p>
        <p className="mt-2 text-xs text-dim">Grupos de 5 o más: señal de 5 € por persona. Cancelación gratis hasta 24 horas antes.</p>

        <span className="mt-5 flex h-12 items-center justify-center rounded-xl bg-ember text-sm font-semibold text-primary-foreground">
          Reservar · mar 10, 21:00, 2 personas
        </span>
        <p className="mt-3 flex items-center justify-center gap-1 text-xs text-dim">
          Reservas con <LogoMark className="size-3" /> llenamos
        </p>
      </div>
    </div>
  )
}

type Status = "sentada" | "por llegar" | "retraso" | "terminada"

const DOT: Record<Status, string> = {
  sentada: "bg-sage",
  "por llegar": "border border-dim bg-transparent",
  retraso: "bg-ember",
  terminada: "bg-[#5f5b53]",
}
const WORD: Record<Status, string> = {
  sentada: "text-sage",
  "por llegar": "text-dim",
  retraso: "text-ember",
  terminada: "text-dim",
}

const ROWS: { time: string; size: number; name: string; source: string; tag?: string; table: string; status: Status }[] = [
  { time: "20:00", size: 2, name: "Jordi Puig", source: "Web", table: "S2", status: "terminada" },
  { time: "20:30", size: 4, name: "Lucía Martín", source: "Instagram", tag: "Habitual", table: "S5", status: "sentada" },
  { time: "20:45", size: 6, name: "Aitana Gil", source: "Google", tag: "Sin gluten", table: "S8+S9", status: "retraso" },
  { time: "21:00", size: 2, name: "Samir Haddad", source: "Teléfono", table: "T1", status: "por llegar" },
  { time: "21:15", size: 3, name: "Marina Soler", source: "Widget", table: "S3", status: "por llegar" },
  { time: "21:30", size: 5, name: "Gorka Etxeberria", source: "Web", tag: "Señal pagada", table: "S6", status: "por llegar" },
]

/** Lista de reservas del día en el panel. */
export function DayListMock() {
  return (
    <div
      role="img"
      aria-label="Ilustración de las reservas del día en el panel de Taberna Lumbre: una fila por reserva con hora, personas, cliente, origen, mesa y estado"
      className="overflow-hidden rounded-2xl border border-white/10 bg-ink text-left select-none"
    >
      <div className="flex flex-wrap items-center gap-3 border-b border-white/5 px-4 py-3">
        <LogoMark className="size-5" />
        <span className="flex items-center gap-2 text-sm font-medium">
          <CalendarBlank aria-hidden="true" className="size-4 text-dim" /> Lunes 9 de noviembre · cena
        </span>
        <span className="ml-auto rounded border border-white/10 px-1.5 py-0.5 text-xs text-dim">Ejemplo</span>
      </div>
      <div className="grid grid-cols-3 gap-2 px-4 pt-4">
        {[
          { l: "Cubiertos", v: "64 / 72" },
          { l: "Por llegar", v: "36" },
          { l: "Señales", v: "55 €" },
        ].map((k) => (
          <div key={k.l} className="rounded-lg border border-white/5 bg-surface px-3 py-2">
            <p className="text-xs text-dim">{k.l}</p>
            <p className="mt-1 font-mono text-base font-medium tabular-nums">{k.v}</p>
          </div>
        ))}
      </div>
      <div className="p-4">
        <div className="hidden grid-cols-[3.5rem_2.5rem_1fr_4.5rem_6.5rem] gap-3 px-3 pb-2 text-xs text-dim sm:grid">
          <span>Hora</span>
          <span>Pers.</span>
          <span>Cliente</span>
          <span>Mesa</span>
          <span>Estado</span>
        </div>
        <ul className="flex flex-col gap-1">
          {ROWS.map((r) => (
            <li
              key={r.name}
              className={cn(
                "grid grid-cols-[3.5rem_1fr_auto] items-center gap-3 rounded-lg border border-white/5 bg-surface px-3 py-2 sm:grid-cols-[3.5rem_2.5rem_1fr_4.5rem_6.5rem]",
                r.status === "terminada" && "opacity-70"
              )}
            >
              <span className="font-mono text-sm">{r.time}</span>
              <span className="hidden items-center gap-1 font-mono text-sm sm:flex">
                <UsersThree aria-hidden="true" className="size-3 text-dim" />
                {r.size}
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{r.name}</span>
                <span className="flex flex-wrap items-center gap-1 text-xs text-dim">
                  <span className="sm:hidden">{r.size} pers. · {r.table} ·</span>
                  {r.source}
                  {r.tag && (
                    <span
                      className={cn(
                        "rounded px-1.5 text-xs",
                        r.tag === "Sin gluten" ? "bg-[#e8857a]/15 text-[#e8857a]" : "bg-white/10 text-foreground"
                      )}
                    >
                      {r.tag}
                    </span>
                  )}
                </span>
              </span>
              <span className="hidden font-mono text-sm sm:block">{r.table}</span>
              <span className={cn("flex items-center gap-2 text-xs", WORD[r.status])}>
                <span className={cn("size-2 shrink-0 rounded-full", DOT[r.status])} />
                {r.status === "retraso" ? (
                  <span className="flex items-center gap-1">
                    <Clock aria-hidden="true" className="size-3" /> Retraso
                  </span>
                ) : (
                  <span className="first-letter:uppercase">{r.status}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}
