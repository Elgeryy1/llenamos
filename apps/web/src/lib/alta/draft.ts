import { defaultReservationSettings, type OnboardingDraft, type Onboarding, type CallableInput } from '@llenamos/core'

export const STEPS = ['Tu restaurante', 'El local', 'El plano', 'Los horarios', 'La carta', 'La prueba', 'Todo listo'] as const
export const SERVER_STEPS: Onboarding['step'][] = ['identity', 'location', 'location', 'hours', 'hours', 'plan', 'review']
export function initialDraft(): OnboardingDraft {
  const settings = defaultReservationSettings()
  settings.publicBooking = true
  settings.duration = { defaultMinutes: 90, tiers: [] }
  settings.week = Object.fromEntries(['mon','tue','wed','thu','fri','sat','sun'].map(day => [day, [{ name: 'Comida', from: '13:00', lastEntry: '15:30' }, { name: 'Cena', from: '20:00', lastEntry: '22:30' }]])) as typeof settings.week
  return { name: '', slug: '', location: { name: 'Principal', address: '', city: '', phone: '' }, settings, floor: { areaName: 'Sala', tableCount: 6, seats: 4 }, menu: [], planId: 'sala', planVersion: 1, acceptedTermsVersion: '' }
}
export type Pending = { name: 'guardarAlta'; input: CallableInput<'guardarAlta'> } | { name: 'completarAlta'; input: CallableInput<'completarAlta'> }
export type SavedDraft = { draft: OnboardingDraft; step: number; onboardingId: string | null; revision: number | null; pending: Pending | null }
export const storageKey = (uid: string) => `llenamos:alta:v1:${uid}`
