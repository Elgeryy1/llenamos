import { describe, expect, it } from "vitest"
import { MESSAGE_TEMPLATES, type MessageChannel } from "../message-model"
import { renderMessage } from "./index"
describe("Plantillas de avisos", () => {
  for (const language of ["es", "ca", "en"] as const)
    for (const template of MESSAGE_TEMPLATES)
      for (const channel of ["email", "whatsapp"] as MessageChannel[])
        it(`${language} ${template} ${channel}`, () => {
          const result = renderMessage({
            language,
            template,
            channel,
            data: {
              guestName: "Ana",
              partySize: 2,
              startAt: 1794312000000,
              timezone: "Europe/Madrid",
              reference: "ABCD23",
              manageUrl: "https://example.test/manage",
              offerUrl: "https://example.test/offer",
              paymentUrl: "https://example.test/pay",
              googleReviewUrl: "https://example.test/review",
            },
          })
          expect(result.body).toContain("Ana")
          expect(result.body).not.toContain("undefined")
          expect(result.subject === null).toBe(channel === "whatsapp")
          expect(result.buttons.length).toBe(
            channel === "whatsapp" && ["confirmation", "pending", "reminder"].includes(template) ? 2 : 0,
          )
          if (template === "waitlist_offer") expect(result.body).toContain("/offer")
          if (template === "review_request") expect(result.body).toContain("/review")
        })
})

it.each(["es", "ca", "en"] as const)(
  "recogida en %s incluye precio, referencia, local y enlace privado",
  (language) => {
    const result = renderMessage({
      template: "takeaway_ready",
      language,
      channel: "email",
      data: {
        guestName: "Ana",
        restaurantName: "Lumbre",
        locationName: "Centro",
        address: "Calle 12",
        phone: "+34600000000",
        reference: "ABCD23",
        startAt: Date.UTC(2026, 10, 9, 13),
        totalCents: 650,
        timezone: "Europe/Madrid",
        manageUrl: "http://local.test/private?t=secret",
      },
    })
    for (const value of [
      "Ana",
      "Lumbre",
      "Centro",
      "Calle 12",
      "+34600000000",
      "ABCD23",
      "http://local.test/private?t=secret",
    ])
      expect(result.body).toContain(value)
    expect(result.body).toMatch(/6[,.]50/)
    expect(result.buttons).toEqual([])
  },
)
