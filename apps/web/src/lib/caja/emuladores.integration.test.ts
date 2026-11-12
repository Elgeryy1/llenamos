// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest"

/** Solo HTTP local y cuentas de demo. Nunca usa credenciales de producción. */
const enabled = process.env.TEST_FIREBASE_EMULATORS === "1"
const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? "127.0.0.1:9103"
const functionHost = process.env.FUNCTIONS_EMULATOR_HOST ?? "127.0.0.1:5013"
const project = process.env.GCLOUD_PROJECT ?? "demo-llenamos"
let token = ""
async function login(email: string) {
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Llenamos2026!",
        returnSecureToken: true,
      }),
    },
  )
  const data = await response.json()
  if (!response.ok || !data.idToken)
    throw new Error(
      "No se puede entrar con la cuenta de demo. Ejecuta pnpm seed.",
    )
  return data.idToken as string
}
async function callable(name: string, data: unknown, bearer: string) {
  return fetch(`http://${functionHost}/${project}/europe-west1/${name}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ data }),
  })
}
describe.skipIf(!enabled)("caja contra emuladores reales de la fila 2", () => {
  beforeAll(async () => {
    if (
      project !== "demo-llenamos" ||
      !/^127\.0\.0\.1:(9103)$/.test(authHost) ||
      !/^127\.0\.0\.1:(5013)$/.test(functionHost)
    )
      throw new Error(
        "Esta prueba solo admite el proyecto demo y los puertos del agente 2.",
      )
    token = await login("propietario@lumbre.test")
  })
  it("Auth real reconoce la cuenta de demo y sus permisos", async () => {
    const response = await fetch(
      `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:lookup?key=demo-api-key`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: token }),
      },
    )
    expect(response.ok).toBe(true)
    expect((await response.json()).users[0].localId).toBe("lumbre-propietario")
  })
  it("una cuenta inexistente o callable ausente nunca se convierte en un cobro confirmado", async () => {
    const response = await callable(
      "verCuenta",
      {
        restaurantId: "demo-lumbre",
        locationId: "centro",
        billId: "cuenta-inexistente-agente2",
      },
      token,
    )
    expect(response.ok).toBe(false)
    const text = await response.text()
    expect(text).not.toContain('"paidCents"')
    expect([400, 403, 404, 500]).toContain(response.status)
  })
  it("un cobro sin parte ni caja válidas no se acepta, tampoco al repetir su intención", async () => {
    const data = {
      restaurantId: "demo-lumbre",
      locationId: "centro",
      requestId: "intencion-invalida-agente2",
      billId: "inexistente",
      expectedRevision: 1,
      partId: "inexistente",
      cashSessionId: "inexistente",
      method: "cash",
      amountCents: 100,
      tipCents: 0,
      tenderedCents: 100,
    }
    for (let i = 0; i < 2; i++) {
      const response = await callable("registrarCobro", data, token)
      expect(response.ok).toBe(false)
      expect(await response.text()).not.toContain('"paymentId"')
    }
  })
})
