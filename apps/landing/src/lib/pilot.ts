import { CONTACT_EMAIL } from "@/content"

export type PilotFields = { local: string; city: string; email: string; phone: string }

/**
 * Enlace `mailto:` con el asunto y el cuerpo rellenos. La web no envía ni guarda nada:
 * el mensaje sale del programa de correo del visitante, si decide enviarlo.
 */
export function pilotMailto(f: PilotFields) {
  const subject = `Alta en Llenamos: ${f.local.trim()} (${f.city.trim()})`
  const body = [
    "Hola, queremos empezar con Llenamos.",
    "",
    `Restaurante: ${f.local.trim()}`,
    `Ciudad: ${f.city.trim()}`,
    `Correo: ${f.email.trim()}`,
    `Teléfono: ${f.phone.trim() || "no indicado"}`,
    "",
    "Si quieres, cuéntanos algo más: cuántas mesas tienes y cómo recibes hoy las reservas.",
    "",
  ].join("\n")
  return `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}

