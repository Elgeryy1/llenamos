// Preparación local con funciones reales de fase 1 y 2. No crea cobros ni facturas.
const project = "demo-llenamos"
const auth = "http://127.0.0.1:9103"
const functions = `http://127.0.0.1:5013/${project}/europe-west1`
const firestore = `http://127.0.0.1:8097/v1/projects/${project}/databases/(default)/documents`
async function login(email) {
  const r = await fetch(
    `${auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-api-key`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email,
        password: "Llenamos2026!",
        returnSecureToken: true,
      }),
    },
  )
  const data = await r.json()
  if (!r.ok) throw new Error("No se puede entrar en el emulador")
  return data.idToken
}
async function call(name, data, token) {
  const r = await fetch(`${functions}/${name}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ data }),
  })
  const result = await r.json()
  if (!r.ok) throw new Error(`${name}: ${result.error?.message}`)
  return result.result
}
const team = await login("equipo@logiqd.test")
await call(
  "cambiarPlan",
  { restaurantId: "demo-lumbre", plan: "completo", moduleOverrides: {} },
  team,
)
console.log(
  "Módulo pos activado por la callable real cambiarPlan, solo en demo local.",
)
const owner = await login("propietario@lumbre.test")
const scope = { restaurantId: "demo-lumbre", locationId: "centro" }
const response = await fetch(
  `${firestore}/restaurants/demo-lumbre/locations/centro/reservations?pageSize=300`,
  { headers: { Authorization: `Bearer ${owner}` } },
)
const reservations = (await response.json()).documents ?? []
const sessionsResponse = await fetch(
  `${firestore}/restaurants/demo-lumbre/locations/centro/tableSessions?pageSize=100`,
  { headers: { Authorization: `Bearer ${owner}` } },
)
const existing = (await sessionsResponse.json()).documents ?? []
let sessionId = existing[0]?.name.split("/").at(-1)
if (!sessionId) {
  for (const reservation of reservations.filter((r) =>
    ["seated", "confirmed"].includes(r.fields.status.stringValue),
  )) {
    try {
      const f = reservation.fields
      const result = await call(
        "abrirMesa",
        {
          ...scope,
          tableIds: f.tableIds.arrayValue.values.map((t) => t.stringValue),
          guests: Number(f.partySize.integerValue),
          reservationId: reservation.name.split("/").at(-1),
        },
        owner,
      )
      sessionId = result.sessionId
      console.log(`Mesa abierta con callable real: ${result.label}`)
      break
    } catch (error) {
      console.log(error.message)
    }
  }
}
if (sessionId && !existing.length) {
  await call(
    "enviarPedido",
    {
      ...scope,
      sessionId,
      lines: [{ kind: "item", itemId: "bravas", quantity: 2 }],
      fire: "all",
    },
    owner,
  )
  console.log("Pedido real de dos raciones enviado a la mesa de demostración.")
}
const takeResponse = await fetch(
  `${firestore}/restaurants/demo-lumbre/locations/centro/takeaways?pageSize=100`,
  { headers: { Authorization: `Bearer ${owner}` } },
)
const takeaways = (await takeResponse.json()).documents ?? []
if (!takeaways.length) {
  const slots = await call(
    "consultarRecogida",
    {
      slug: "taberna-lumbre",
      locationId: "centro",
      date: new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Madrid",
      }).format(new Date()),
    },
    owner,
  )
  const start = slots.slots.find((s) => s.available)
  if (start) {
    await call(
      "crearParaLlevar",
      {
        ...scope,
        guestName: "Cliente de prueba de caja",
        phone: "+34612345678",
        date: start.wallDate,
        time: start.time,
        source: "walk_in",
        lines: [{ kind: "item", itemId: "bravas", quantity: 1 }],
      },
      owner,
    )
    console.log("Recogida de demostración creada con callable real.")
  } else
    console.log(
      "No hay franja disponible para crear recogida. No se inventa una.",
    )
}
