/** ¿Ha vencido la suscripción del restaurante? Solo los restaurantes con suscripción (fase 6) tienen fecha de acceso. */
export function accesoVencido(restaurant: { entitlementVersion?: number; accessValidUntil?: number }, now: number = Date.now()): boolean {
  return restaurant.entitlementVersion != null && restaurant.accessValidUntil != null && now >= restaurant.accessValidUntil
}

export const TEXTO_ACCESO_VENCIDO = "La suscripción de este restaurante no está vigente, así que el servicio está en pausa. Tus datos están a salvo. Revisa Plan y facturación para recuperarlo."
