"use client"
import { usePublic } from "@/components/publica/PublicContext"
import { PublicShell } from "@/components/publica/PublicShell"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { OrderLines } from "@/components/mesa-publica/OrderLines"
import { MenuError } from "@/components/mesa-publica/MenuState"
import { usePublicCall } from "@/lib/mesa-publica/consulta"
import { publicText } from "@/lib/mesa-publica/textos"
import { euros } from "@/lib/carta/forms"
import { menuUi } from "@llenamos/core"
export function TrackingApp({ slug, reference, token }: { slug: string; reference: string; token: string }) {
  const { lang } = usePublic()
  const state = usePublicCall("verParaLlevarPublico", token ? { slug, reference, token } : null, true)
  const data = state.data
  return (
    <PublicShell name={null} brandColor={null}>
      <h1 className="mb-5 text-2xl font-semibold">
        {menuUi(lang, "takeaway")} · <span className="cifra">{reference}</span>
      </h1>
      {!token ? (
        <Notice tone="error">{publicText(lang, "noToken")}</Notice>
      ) : (
        <>
          {state.error && <MenuError error={state.error} />}
          {!data && !state.error && <p role="status">{publicText(lang, "checking")}</p>}
          <Button className="my-5 h-12 w-full" variant="outline" onClick={state.refresh}>
            {publicText(lang, "refresh")}
          </Button>
          {data && (
            <section className="superficie space-y-4 p-5">
              <h2 className="text-xl font-semibold text-warning">{publicText(lang, data.status)}</h2>
              <p>
                {data.guestName} · {data.locationName}
              </p>
              <p className="cifra">
                {new Intl.DateTimeFormat(lang, {
                  dateStyle: "medium",
                  timeStyle: "short",
                  timeZone: data.timezone,
                }).format(data.pickupAt)}
              </p>
              {data.notifications?.map((n) => (
                <p key={`${n.channel}:${n.template}`} className="text-sm text-muted-foreground">
                  {menuUi(lang, n.channel === "email" ? "emailChannel" : "whatsappChannel")} ·{" "}
                  {menuUi(lang, n.template === "takeaway_accepted" ? "takeawayAccepted" : "takeawayReady")}:{" "}
                  {menuUi(
                    lang,
                    (
                      {
                        queued: "notificationQueued",
                        sent: "notificationSent",
                        captured: "notificationCaptured",
                        not_configured: "notificationNotConfigured",
                        failed: "notificationFailed",
                        cancelled: "notificationCancelled",
                      } as const
                    )[n.status],
                  )}
                </p>
              ))}
              <OrderLines lines={data.lines} lang={lang} takeaway />
              <p className="flex justify-between border-t pt-4 font-semibold">
                <span>{menuUi(lang, "total")}</span>
                <span className="cifra">{euros(data.totalCents, lang)}</span>
              </p>
              <p className="text-xs text-muted-foreground">
                {menuUi(lang, "vatIncluded")}. {menuUi(lang, "takeawayPayAtPickup")}
              </p>
            </section>
          )}
        </>
      )}
    </PublicShell>
  )
}
