"use client"
import { useEffect, useRef, useState } from "react"
import {
  horaLocal,
  menuUi,
  ORDER_PROBLEM_TEXT,
  takeawayTrackPath,
  type OrderLineInput,
  type PublicMenu,
} from "@llenamos/core"
import { usePublic } from "@/components/publica/PublicContext"
import { TextField, SelectField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Toggle } from "@/components/carta/Fields"
import { Cart } from "@/components/mesa-publica/Cart"
import { Catalog } from "@/components/mesa-publica/Catalog"
import { MenuError } from "@/components/mesa-publica/MenuState"
import { callTakeaway } from "@/lib/para-llevar-publico/pedido"
import { usePublicCall } from "@/lib/mesa-publica/consulta"
import { publicText } from "@/lib/mesa-publica/textos"
import { ServiceError } from "@/lib/carta/callables"
import { euros } from "@/lib/carta/forms"
import { CartShortcut } from "@/components/mesa-publica/CartShortcut"
import { PickupDate } from "./PickupDate"
import { useNow } from "@/lib/use-now"

export function TakeawayApp({
  slug,
  locationId,
  menu,
  timezone,
}: {
  slug: string
  locationId: string
  menu: PublicMenu | null
  timezone: string
}) {
  const { lang } = usePublic()
  const now = useNow()
  const today = horaLocal(now.getTime(), timezone).fecha
  const [date, setDate] = useState(today),
    [time, setTime] = useState("")
  const slots = usePublicCall("consultarRecogida", { slug, locationId, date })
  const slot = slots.data?.slots.find((s) => s.time === time && s.available)
  const [name, setName] = useState(""),
    [phone, setPhone] = useState(""),
    [email, setEmail] = useState("")
  const [policy, setPolicy] = useState(false),
    [lines, setLines] = useState<OrderLineInput[]>([])
  const [revision, setRevision] = useState(0)
  const [pending, setPending] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState<unknown>(null)
  const [receipt, setReceipt] = useState<{ path: string; reference: string; total: number } | null>(null)
  const lock = useRef(false),
    storageKey = `llenamos:recogida:envio:${slug}:${locationId}`
  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(storageKey)
      if (saved)
        queueMicrotask(() => {
          if (saved === "pending") setUncertain(true)
          else {
            try {
              setReceipt(JSON.parse(saved))
            } catch {
              setUncertain(true)
            }
          }
        })
    } catch {
      /* El bloqueo en memoria funciona sin almacenamiento. */
    }
  }, [storageKey])
  async function send(total: number, note: string) {
    if (lock.current || uncertain || !slot || slots.error || !menu?.takeaway.enabled) return
    if (!policy) {
      setError(new Error(publicText(lang, "consent")))
      return
    }
    const input = {
      slug,
      locationId,
      date,
      time,
      guestName: name,
      phone,
      email,
      language: lang,
      lines,
      expectedTotalCents: total,
      notes: note,
      acceptPolicy: true as const,
      website: "",
    }
    lock.current = true
    setPending(true)
    setError(null)
    try {
      const { CALLABLE_SCHEMAS } = await import("@llenamos/core")
      CALLABLE_SCHEMAS.pedirParaLlevar.input.parse(input)
      try {
        sessionStorage.setItem(storageKey, "pending")
      } catch {
        /* El bloqueo en memoria sigue activo. */
      }
      const result = await callTakeaway("pedirParaLlevar", input)
      if (result.status === "rejected") {
        setRevision((n) => n + 1)
        setError(
          new Error(
            `${result.problems.map((p) => ORDER_PROBLEM_TEXT[lang][p.code]).join(" ")} ${publicText(lang, "serverTotal")}: ${euros(result.totalCents, lang)}`,
          ),
        )
        slots.refresh()
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* Sin almacenamiento. */
        }
      } else {
        const next = {
          path: takeawayTrackPath(slug, result.reference, result.manageToken),
          reference: result.reference,
          total: result.totalCents,
        }
        setReceipt(next)
        setLines([])
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(next))
        } catch {
          /* Se muestra el enlace aunque no se pueda guardar. */
        }
      }
    } catch (e) {
      setError(e)
      if (e instanceof ServiceError && e.code === "uncertain") setUncertain(true)
      else {
        try {
          sessionStorage.removeItem(storageKey)
        } catch {
          /* Sin almacenamiento. */
        }
      }
    } finally {
      lock.current = false
      setPending(false)
    }
  }
  if (receipt)
    return (
      <section className="superficie space-y-4 p-5">
        <h2 className="text-xl font-semibold">{menuUi(lang, "takeawayReceived")}</h2>
        <p className="cifra text-2xl">{receipt.reference}</p>
        <p>
          {publicText(lang, "serverTotal")}: {euros(receipt.total, lang)}
        </p>
        <p className="text-sm text-muted-foreground">{publicText(lang, "tracking")}</p>
        <Button asChild className="h-12 w-full">
          <a href={receipt.path}>{publicText(lang, "refresh")}</a>
        </Button>
        <p className="text-sm">{menuUi(lang, "takeawayPayAtPickup")}</p>
      </section>
    )
  return (
    <>
      <section className="superficie mb-5 space-y-4 p-4">
        <h2 className="text-xl font-semibold">{menuUi(lang, "takeaway")}</h2>
        <PickupDate
          min={today}
          value={date}
          onChange={(value) => {
            setDate(value)
            setTime("")
          }}
        />
        {!!slots.error && <MenuError error={slots.error} />}
        {slots.data ? (
          !slots.data.enabled ? (
            <Notice>{publicText(lang, "noPickup")}</Notice>
          ) : slots.data.slots.some((s) => s.available) ? (
            <SelectField
              className="h-12"
              label={menuUi(lang, "pickupTime")}
              value={time}
              onChange={(e) => setTime(e.target.value)}
            >
              <option value="">{menuUi(lang, "choose")}</option>
              {slots.data.slots.map((s) => (
                <option key={`${s.wallDate}:${s.time}`} value={s.time} disabled={!s.available}>
                  {s.time} · {s.wallDate} · {s.shift}
                  {!s.available ? " · ×" : ""}
                </option>
              ))}
            </SelectField>
          ) : (
            <Notice>{menuUi(lang, "noPickupSlots")}</Notice>
          )
        ) : (
          !slots.error && (
            <p role="status" className="text-sm text-muted-foreground">
              {publicText(lang, "checking")}
            </p>
          )
        )}
        <Button variant="outline" className="h-12 w-full" onClick={slots.refresh}>
          {publicText(lang, "refresh")}
        </Button>
      </section>
      {!!error && <MenuError error={error} />}
      {uncertain && <Notice tone="warning">{publicText(lang, "uncertain")}</Notice>}
      {menu && (
        <>
          <CartShortcut count={lines.length} lang={lang} />
          <Catalog
            menu={menu}
            language={lang}
            channel="takeaway"
            at={slot?.startAt ?? now.getTime()}
            canAdd={!!slot && menu.takeaway.enabled && !uncertain && !slots.error && !pending}
            onAdd={(line) => setLines((x) => (x.length < 50 ? [...x, line] : x))}
          />
          {!slot && <p className="my-4 text-sm text-muted-foreground">{publicText(lang, "selectTime")}</p>}
          <Cart
            revision={revision}
            menu={menu}
            lang={lang}
            channel="takeaway"
            at={slot?.startAt ?? now.getTime()}
            lines={lines}
            onChange={setLines}
            pending={pending}
            blocked={uncertain || !slot || !!slots.error || !menu.takeaway.enabled}
            onSend={(total, note) => void send(total, note)}
          >
            <fieldset disabled={pending || uncertain} className="space-y-4">
              <TextField
                label={publicText(lang, "name")}
                className="h-12"
                autoComplete="name"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <TextField
                label={publicText(lang, "phone")}
                className="h-12"
                type="tel"
                autoComplete="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
              <TextField
                label={publicText(lang, "email")}
                className="h-12"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
              <Toggle label={publicText(lang, "policy")} checked={policy} onChange={setPolicy} />
            </fieldset>
          </Cart>
        </>
      )}
    </>
  )
}
