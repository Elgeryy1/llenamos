import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, it, expect, vi } from "vitest"
import { MODULES, type CallableOutput } from "@llenamos/core"
import { FichaFidelizacion } from "./FichaFidelizacion"
import { DescuentosCuenta } from "./DescuentosCuenta"
import { ProgramaVista } from "./Programa"
import { PromocionesVista } from "./Promociones"
import { RepiteVista } from "./Repite"
import { apiFixture, CLIENTE_FIXTURE, cuentaFixture, cuentaPuntosFixture, programaFixture, premiosFixture, promocionesFixture, repiteFixture, promocionesAplicablesFixture } from "@/lib/fidelizacion/fixtures"
import { catalogoFixture } from "@/lib/fidelizacion/catalogo"
import type { ApiFidelizacion } from "@/lib/fidelizacion/api"

vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} })

const camarero = { role: "waiter" as const, modules: MODULES }
const encargado = { role: "manager" as const, modules: MODULES }
const cliente = { restaurantId: "demo-lumbre", customerId: CLIENTE_FIXTURE, customerName: "Clara", termsVersion: "2026.1", locationId: "centro", sessionId: "visita", ...camarero }
const caja = { restaurantId: "demo-lumbre", locationId: "centro", bill: cuentaFixture, ...camarero }
const base = { restaurantId: "demo-lumbre", acceso: camarero, api: apiFixture }

function doble(respuestas: Partial<Record<Parameters<ApiFidelizacion>[0], unknown>>) {
  const llamada = vi.fn(async (nombre: Parameters<ApiFidelizacion>[0], entrada: unknown) => {
    if (nombre in respuestas) return respuestas[nombre]
    return apiFixture(nombre, entrada as never)
  })
  return { api: llamada as ApiFidelizacion, llamada }
}

describe("permisos y operaciones de caja", () => {
  it("el camarero aplica una promoción y espera la cuenta real antes de otra operación", async () => {
    const { api, llamada } = doble({ aplicarPromocion: { status: "applied", discountCents: 630, billRevision: 2, totalCents: 3570 } })
    const recargar = vi.fn()
    const { rerender } = render(<DescuentosCuenta {...caja} api={api} onBillChanged={recargar} />)
    const aplicar = await screen.findByRole("button", { name: "Aplicar Las noches del jueves" })
    fireEvent.click(aplicar)
    await waitFor(() => expect(recargar).toHaveBeenCalledWith(2))
    expect(screen.getByText(/Esperando la cuenta actualizada/)).toBeTruthy()
    expect((await screen.findByRole("button", { name: "Canjear Cinco euros para volver" }) as HTMLButtonElement).disabled).toBe(true)
    const datos = llamada.mock.calls.find(([n]) => n === "aplicarPromocion")?.[1]
    expect(datos).toMatchObject({ expectedBillRevision: 1, billId: cuentaFixture.id, promotionId: "promo-cena" })
    expect(datos).not.toHaveProperty("discountCents")
    rerender(<DescuentosCuenta {...caja} bill={{ ...cuentaFixture, revision: 2 }} api={api} onBillChanged={recargar} />)
    await waitFor(() => expect(screen.queryByText(/Esperando la cuenta actualizada/)).toBeNull())
  })
  it("enseña el motivo si otra caja gasta el último cupo sin anunciar un éxito", async () => {
    const { api } = doble({ aplicarPromocion: { status: "rejected", reason: "usage_limit", message: "Otra caja acaba de usar el último cupo." } })
    const recargar = vi.fn()
    render(<DescuentosCuenta {...caja} api={api} onBillChanged={recargar} />)
    fireEvent.click(await screen.findByRole("button", { name: "Aplicar Las noches del jueves" }))
    expect(await screen.findByText(/Otra caja acaba de usar el último cupo/)).toBeTruthy()
    expect(screen.queryByText(/Promoción confirmada/)).toBeNull()
    expect(recargar).not.toHaveBeenCalled()
  })
  it("el camarero canjea puntos con la revisión y el premio, sin calcular descuentos", async () => {
    const { api, llamada } = doble({ canjearPuntos: { status: "applied", redemptionId: "canje", points: 150, discountCents: 500, available: 30, billRevision: 2 } })
    const recargar = vi.fn()
    render(<DescuentosCuenta {...caja} api={api} onBillChanged={recargar} />)
    fireEvent.click(await screen.findByRole("button", { name: "Canjear Cinco euros para volver" }))
    expect(await screen.findByText(/Canje confirmado/)).toBeTruthy()
    expect(llamada.mock.calls.find(([n]) => n === "canjearPuntos")?.[1]).toMatchObject({ customerId: CLIENTE_FIXTURE, expectedBillRevision: 1, rewardId: "premio-cuenta" })
  })
  it("un saldo insuficiente no cambia la cuenta", async () => {
    const { api } = doble({ canjearPuntos: { status: "insufficient", available: 20, pointsCost: 150 } })
    const recargar = vi.fn()
    render(<DescuentosCuenta {...caja} api={api} onBillChanged={recargar} />)
    fireEvent.click(await screen.findByRole("button", { name: "Canjear Cinco euros para volver" }))
    expect(await screen.findByText(/No hay puntos suficientes/)).toBeTruthy()
    expect(recargar).not.toHaveBeenCalled()
  })
  it("anula canjes y quita promociones con motivo y revisión", async () => {
    const { api, llamada } = doble({ anularCanje: { available: 180, billRevision: 2 }, quitarPromocion: { billRevision: 2, totalCents: 4200 } })
    const ajustes = [{ id: "p", lineId: "linea-cena", kind: "discount" as const, amountCents: 200, reason: "Prueba", at: 1, by: "u", promotionId: "promo-cena" }, { id: "r", lineId: "linea-cena", kind: "discount" as const, amountCents: 500, reason: "Premio", at: 1, by: "u", redemptionId: "canje" }]
    const { unmount } = render(<DescuentosCuenta {...caja} bill={{ ...cuentaFixture, adjustments: ajustes }} api={api} onBillChanged={vi.fn()} />)
    expect((screen.getByRole("button", { name: "Anular canje 1" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByLabelText("Motivo para quitar o anular"), { target: { value: "El cliente prefiere conservar los puntos" } })
    fireEvent.click(screen.getByRole("button", { name: "Anular canje 1" }))
    expect(await screen.findByText(/Canje anulado/)).toBeTruthy()
    expect(llamada.mock.calls.find(([n]) => n === "anularCanje")?.[1]).toMatchObject({ redemptionId: "canje", expectedBillRevision: 1, reason: "El cliente prefiere conservar los puntos" })
    unmount()
    render(<DescuentosCuenta {...caja} bill={{ ...cuentaFixture, adjustments: ajustes }} api={api} onBillChanged={vi.fn()} />)
    fireEvent.change(screen.getByLabelText("Motivo para quitar o anular"), { target: { value: "Cambio de promoción" } })
    fireEvent.click(screen.getByRole("button", { name: "Quitar promoción" }))
    expect(await screen.findByText("Promoción retirada por el servidor.")).toBeTruthy()
  })
  it("una cuenta cobrada y un módulo apagado impiden operar", async () => {
    const { unmount } = render(<DescuentosCuenta {...caja} bill={{ ...cuentaFixture, status: "settled" }} api={apiFixture} onBillChanged={vi.fn()} />)
    expect((await screen.findByRole("button", { name: "Aplicar Las noches del jueves" }) as HTMLButtonElement).disabled).toBe(true)
    unmount()
    const llamada = vi.fn()
    render(<DescuentosCuenta {...caja} modules={["pos"]} api={llamada as ApiFidelizacion} onBillChanged={vi.fn()} />)
    expect(screen.getByText(/Tu acceso no permite aplicar descuentos/)).toBeTruthy()
    expect(llamada).not.toHaveBeenCalled()
  })
  it("las pantallas de configuración rechazan al camarero", () => {
    render(<><ProgramaVista {...base} settings={programaFixture} rewards={premiosFixture} catalogo={catalogoFixture} /><PromocionesVista {...base} promociones={promocionesFixture} catalogo={catalogoFixture} /><RepiteVista {...base} settings={repiteFixture} /></>)
    expect(screen.queryByRole("button", { name: "Guardar programa" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Nueva promoción" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Guardar ajustes" })).toBeNull()
  })
})

describe("ficha de fidelización y Repite", () => {
  it("el alta empieza sin aceptar condiciones y no sirve como permiso de marketing", async () => {
    const { api, llamada } = doble({ verCuentaFidelizacion: { ...cuentaPuntosFixture, enrolled: false, movements: [] }, altaFidelizacion: { balance: 0, enrolledAt: 1, alreadyEnrolled: false } })
    render(<FichaFidelizacion {...cliente} api={api} />)
    const alta = await screen.findByRole("button", { name: "Dar de alta" })
    expect((alta as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText("El alta no da permiso para enviar campañas.")).toBeTruthy()
    fireEvent.click(screen.getByRole("checkbox"))
    fireEvent.click(alta)
    expect(await screen.findByText("Alta confirmada por el servidor.")).toBeTruthy()
    expect(llamada.mock.calls.find(([n]) => n === "altaFidelizacion")?.[1]).toMatchObject({ acceptedTermsVersion: "2026.1" })
  })
  it("no inventa condiciones si no se han leído", async () => {
    const { api } = doble({ verCuentaFidelizacion: { ...cuentaPuntosFixture, enrolled: false } })
    render(<FichaFidelizacion {...cliente} termsVersion={null} api={api} />)
    expect(await screen.findByText(/Falta la versión de las condiciones/)).toBeTruthy()
    expect((screen.getByRole("button", { name: "Dar de alta" }) as HTMLButtonElement).disabled).toBe(true)
  })
  it("una tarjeta en cola queda pendiente y nunca se presenta como creada", async () => {
    const { api } = doble({ verTarjetaRepite: { status: "no_card" }, crearTarjetaRepite: { status: "queued" } })
    render(<FichaFidelizacion {...cliente} api={api} />)
    fireEvent.click(await screen.findByRole("button", { name: "Crear tarjeta" }))
    expect(await screen.findByText("Tarjeta pendiente. Repite todavía no la ha confirmado.")).toBeTruthy()
    expect(screen.queryByText(/Tarjeta creada y confirmada/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Registrar ajuste" })).toBeNull()
  })
  it("un sello en cola no se enseña como dado", async () => {
    const { api } = doble({ verTarjetaRepite: { status: "ready", card: { cardId: "c", status: "active", stamps: 3, stampsForReward: 10, rewardsAvailable: 0, inWallet: true, lastStampAt: null }, fetchedAt: 1 }, darSelloRepite: { operationId: "stamp.visita", status: "queued" } })
    render(<FichaFidelizacion {...cliente} api={api} />)
    fireEvent.click(await screen.findByRole("button", { name: "Dar sello de esta visita" }))
    expect(await screen.findByText("Sello pendiente. Repite todavía no lo ha confirmado.")).toBeTruthy()
  })
  it("ignora la respuesta del cliente anterior si llega tarde", async () => {
    let resolver: ((v: CallableOutput<"verCuentaFidelizacion">) => void) | undefined
    const { api } = doble({ verCuentaFidelizacion: new Promise((resolve) => { resolver = resolve }) })
    const { rerender } = render(<FichaFidelizacion {...cliente} modules={["loyalty"]} api={api} />)
    rerender(<FichaFidelizacion {...cliente} customerId="bbbbbbbbbbbbbbbbbbbb" api={apiFixture} />)
    await screen.findByText("Últimos movimientos")
    await act(async () => resolver?.({ ...cuentaPuntosFixture, available: 9999 }))
    expect(screen.queryByText("9999")).toBeNull()
  })
  it("si falta backend la demo solo muestra el error, sin éxito", async () => {
    render(<DescuentosCuenta {...caja} api={apiFixture} onBillChanged={vi.fn()} />)
    fireEvent.click(await screen.findByRole("button", { name: "Aplicar Las noches del jueves" }))
    expect(await screen.findByText(/Falta el backend para confirmar/)).toBeTruthy()
    expect(screen.queryByText(/Promoción confirmada/)).toBeNull()
  })
  it("solo manda los ajustes de Repite permitidos al encargado, sin comercio", async () => {
    const { api, llamada } = doble({ guardarAjustesRepite: { ok: true, connected: false } })
    render(<RepiteVista restaurantId="demo-lumbre" acceso={encargado} settings={repiteFixture} api={api} />)
    fireEvent.click(screen.getByRole("button", { name: "Guardar ajustes" }))
    expect(await screen.findByText(/Ajustes guardados. Repite sigue sin estar conectado/)).toBeTruthy()
    expect(llamada.mock.calls.find(([n]) => n === "guardarAjustesRepite")?.[1]).toMatchObject({ settings: { enabled: false, stampOn: "both", autoCreateCard: false } })
    expect((llamada.mock.calls.find(([n]) => n === "guardarAjustesRepite")?.[1] as { settings: unknown }).settings).not.toHaveProperty("merchantId")
  })
})

it("conserva las franjas nocturnas, el código y los cupos al editar una promoción", async () => {
  const { api, llamada } = doble({ guardarPromocion: { promotionId: "promo-cena", revision: 3, status: "active" } })
  render(<PromocionesVista restaurantId="demo-lumbre" acceso={encargado} promociones={promocionesFixture} catalogo={catalogoFixture} api={api} />)
  fireEvent.click(screen.getByRole("button", { name: "Editar Las noches del jueves" }))
  fireEvent.change(screen.getByLabelText("Código opcional"), { target: { value: "NOCHE" } })
  fireEvent.click(screen.getByRole("button", { name: "Guardar promoción" }))
  expect(await screen.findByText(/Promoción guardada/)).toBeTruthy()
  expect(llamada.mock.calls.find(([n]) => n === "guardarPromocion")?.[1]).toMatchObject({ expectedRevision: 2, promotion: { timeWindows: [{ from: "22:00", to: "02:00" }], weekdays: [4], code: "NOCHE", usageLimit: 40, perCustomerLimit: 1, stacking: "with_loyalty" } })
  expect(promocionesAplicablesFixture.evaluations[0].eligible).toBe(true)
})
