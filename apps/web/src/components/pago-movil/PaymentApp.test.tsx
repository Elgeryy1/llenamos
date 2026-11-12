import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { PublicProvider } from '@/components/publica/PublicContext'
import type { PublicBill } from '@/lib/pago-movil/api'
import { PaymentApp } from './PaymentApp'
const mocks = vi.hoisted(() => ({ call: vi.fn(), refresh: vi.fn() }))
let result: PublicBill
vi.mock('@/lib/pago-movil/use-query', () => ({ useMobileQuery: () => ({ result, refresh: mocks.refresh }) }))
vi.mock('@/lib/pago-movil/api', async original => ({ ...await original<typeof import('@/lib/pago-movil/api')>(), mobileCall: mocks.call }))
const link = { slug: 'lumbre', locationId: 'centro', checkoutId: 'private', token: 'a'.repeat(43) }
const app = () => <PublicProvider initialLang="es"><PaymentApp link={link} /></PublicProvider>
beforeEach(() => {
  localStorage.clear(); sessionStorage.clear(); mocks.call.mockReset()
  result = { restaurantName: 'Restaurante de prueba', locationName: 'Centro', brandColor: '#d99b63', label: 'Parte 1',
    lines: [{ name: 'Arroz', amountCents: 2600 }], amountCents: 2600, expiresAt: Date.now() + 900000, status: 'pending',
    paymentsEnabled: true, tipCents: 0, paidCents: 0, receiptPath: null, invoicePending: false, delivery: 'none' }
})
describe('Cuenta pública con datos de prueba explícitos', () => {
  it('sin Stripe deshabilita el pago y explica que no se ha cobrado', () => {
    result.paymentsEnabled = false
    render(app())
    expect(screen.getByRole('button', { name: /Continuar al pago/ }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/No se ha cobrado nada/)).toBeTruthy()
  })
  it('separa la propina y no manda correo sin consentimiento', async () => {
    mocks.call.mockResolvedValue({ status: 'not_configured', message: 'Sin configurar' })
    render(app())
    fireEvent.change(screen.getByLabelText('Otro importe en euros'), { target: { value: '1,30' } })
    fireEvent.click(screen.getByRole('button', { name: /Continuar al pago/ }))
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    expect(mocks.call.mock.calls[0]![2]).toMatchObject({ tipCents: 130, email: null, acceptDigitalReceipt: false })
    expect(mocks.call.mock.calls[0]![2]).not.toHaveProperty('amountCents')
  })
  it('el doble toque conserva una sola intención y una sola llamada', async () => {
    mocks.call.mockImplementation(() => new Promise(() => {}))
    render(app())
    const pay = screen.getByRole('button', { name: /Continuar al pago/ })
    fireEvent.click(pay); fireEvent.click(pay)
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: /Preparando el pago/ }).hasAttribute('disabled')).toBe(true)
  })
  it('un cobro confirmado pendiente de factura nunca vuelve a ofrecer pagar', () => {
    result.status = 'paid'; result.paidCents = 2600; result.invoicePending = true
    render(app())
    expect(screen.getByText('Pago confirmado')).toBeTruthy()
    expect(screen.getByText(/La factura o el recibo siguen pendientes/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Continuar al pago/ })).toBeNull()
  })
  it('al recuperar una visita conserva el Checkout iniciado y evita otra intención', () => {
    result.paymentInProgress = true
    result.checkoutUrl = 'https://checkout.stripe.com/c/pay/cs_test_existing'
    render(app())
    expect(screen.getByRole('link', { name: 'Continuar al pago' }).getAttribute('href')).toBe(result.checkoutUrl)
    expect(screen.queryByLabelText('Otro importe en euros')).toBeNull()
    expect(mocks.call).not.toHaveBeenCalled()
  })
  it('cambia todos los textos del pago al inglés', () => {
    render(app())
    fireEvent.click(screen.getByRole('radio', { name: 'English' }))
    expect(screen.getByRole('heading', { name: 'Your bill, at your pace' })).toBeTruthy()
    expect(screen.getByText('Leave a tip?')).toBeTruthy()
  })
})
