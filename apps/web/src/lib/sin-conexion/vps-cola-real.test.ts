import { beforeEach, describe, expect, it, vi } from "vitest"
import { CommandReceiptSchema, canonicalJson, commandFingerprint, sha256Hex, syncStreamKey, type OfflineCommand } from "@llenamos/core"

/** IndexedDB mínimo: lo justo para que `almacen.ts` real guarde y lea el espacio de la cola. */
function fakeIndexedDB() {
  const stores = new Map<string, Map<string, unknown>>()
  return { open() {
    const req: { result?: unknown; onsuccess?: () => void; onupgradeneeded?: () => void; onerror?: () => void } = {}
    queueMicrotask(() => {
      const db = {
        createObjectStore: (name: string) => stores.set(name, new Map()),
        transaction: (name: string) => {
          const tx: { oncomplete?: () => void; onabort?: () => void; onerror?: () => void; abort: () => void; objectStore: () => unknown } = {
            abort: () => tx.onabort?.(),
            objectStore: () => ({
              get: (key: string) => { const r: { result?: unknown; onsuccess?: () => void } = {}; queueMicrotask(() => { r.result = structuredClone(stores.get(name)!.get(key)); r.onsuccess?.(); queueMicrotask(() => tx.oncomplete?.()) }); return r },
              put: (value: { key: string }) => { stores.get(name)!.set(value.key, structuredClone(value)) },
            }),
          }
          return tx
        },
      }
      req.result = db
      if (!stores.has("spaces")) req.onupgradeneeded?.()
      req.onsuccess?.()
    })
    return req
  } }
}

const mocks = vi.hoisted(() => ({ post: vi.fn(), prepared: new Map<string, string>() }))
vi.mock("@/lib/firebase/auth-client", () => ({ getFirebaseIdentity: () => ({ auth: { currentUser: { uid: "waiter" }, }, }), identityToken: async () => "t" }))
vi.mock("firebase/auth", () => ({ onAuthStateChanged: vi.fn() }))
vi.mock("@/lib/api/transport", async (original) => ({ ...(await original<typeof import("@/lib/api/transport")>()), postOperation: mocks.post }))

const alcance = { restaurantId: "r", locationId: "l" }
const lineId = "linea1", itemId = "plato1"
let hashes: Record<string, string>

/** El servidor de pruebas: versiones, recibos y respuestas con la forma del contrato. */
type Entidad = { kind: string; id: string }
function servidor(name: string, data: { entities?: Entidad[]; command?: OfflineCommand }) {
  if (name === "prepararSinConexion") {
    return { versions: data.entities!.map((e) => ({ kind: e.kind, id: e.id, version: `v-${e.id}` })), contentHashes: data.entities!.map((e) => ({ kind: e.kind, id: e.id, hash: hashes[e.id] })), synchronizedAt: Date.now() }
  }
  if (name === "sincronizarComando") {
    const command = data.command!
    const response = command.operation === "marcarAgotado" ? { ok: true, soldOut: true } : { ok: true, lines: [{ id: lineId, status: "preparing" }], firedNext: [] }
    return { receipt: CommandReceiptSchema.parse({ commandId: command.commandId, streamKey: syncStreamKey(command), sequence: command.sequence, fingerprint: commandFingerprint(command),
      result: { status: "applied", response, versions: command.preconditions.map(p => ({ kind: p.kind, id: p.id, version: `${p.version}-2` })) }, recordedAt: Date.now() }) }
  }
  if (name === "marcarAgotado") return { ok: true, soldOut: true }
  if (name === "cambiarEstadoLineas") return { ok: true, lines: [{ id: lineId, status: "preparing" }], firedNext: [] }
  if (name === "enviarPedido") return { status: "sent", orderId: "o1", lineIds: [], totalCents: 0, sessionTotalCents: 0, fired: 0, held: 0 }
  throw new Error(`sin servidor para ${name}`)
}

describe("el envoltorio de sala y cocina con la cola real (almacén sobre IndexedDB)", () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    vi.stubGlobal("indexedDB", fakeIndexedDB())
    Object.defineProperty(navigator, "onLine", { configurable: true, value: true })
    Object.defineProperty(navigator, "locks", { configurable: true, value: { request: async (_n: string, _o: unknown, work: (lock: object) => Promise<void>) => work({}) } })
    localStorage.clear()
    mocks.post.mockReset()
    mocks.post.mockImplementation(async (name: string, data: unknown) => servidor(name, data as Parameters<typeof servidor>[1]))
    hashes = { [lineId]: sha256Hex(canonicalJson({ id: lineId })), [itemId]: sha256Hex(canonicalJson({ id: itemId })) }
  })
  const llamados = () => mocks.post.mock.calls.map(c => c[0])

  it("una recogida y el estado de un plato sin versión preparada van directos a la API con conexión", async () => {
    const { llamarSala } = await import("@/lib/comandero/callables")
    await llamarSala("enviarPedido", { ...alcance, takeawayId: "rec1", lines: [{ kind: "item", itemId: "bravas", quantity: 1 }] } as never)
    await llamarSala("cambiarEstadoLineas", { ...alcance, lineIds: [lineId], status: "preparing" })
    expect(llamados()).toEqual(["enviarPedido", "cambiarEstadoLineas"])
  })
  it("agotar un plato sin preparar la pantalla va directo y no bloquea nada", async () => {
    const { llamarSala } = await import("@/lib/comandero/callables")
    const { llamarCocina } = await import("@/lib/cocina/callables")
    expect(await llamarSala("marcarAgotado", { ...alcance, itemId, soldOut: true })).toEqual({ ok: true, soldOut: true })
    expect(await llamarCocina("marcarAgotado", { ...alcance, itemId, soldOut: true })).toEqual({ ok: true, soldOut: true })
    expect(llamados()).toEqual(["marcarAgotado", "marcarAgotado"])
  })
  it("con la pantalla preparada el cambio pasa por la cola y se sincroniza con el servicio sync", async () => {
    const { prepare } = await import("@/lib/sin-conexion/cliente")
    const { llamarCocina } = await import("@/lib/cocina/callables")
    await prepare((await import("@/lib/sin-conexion/almacen")).scopeFor("r", "l", "waiter"), [{ kind: "line", id: lineId, observed: { id: lineId } }])
    const out = await llamarCocina("cambiarEstadoLineas", { ...alcance, lineIds: [lineId], status: "preparing" })
    expect(out).toMatchObject({ ok: true })
    expect(llamados()).toEqual(["prepararSinConexion", "sincronizarComando"])
  })
  it("sin conexión y sin preparar, no se envía y se explica", async () => {
    Object.defineProperty(navigator, "onLine", { configurable: true, value: false })
    const { llamarSala } = await import("@/lib/comandero/callables")
    await expect(llamarSala("cambiarEstadoLineas", { ...alcance, lineIds: [lineId], status: "preparing" })).rejects.toThrow(/conexión/)
    expect(mocks.post).not.toHaveBeenCalled()
  })
})
