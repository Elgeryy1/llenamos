/**
 * Textos de la carta en tres idiomas: `{ es, ca, en }`.
 *
 * El castellano es obligatorio; el catalán y el inglés pueden quedar vacíos y entonces se
 * enseña el castellano. En Firestore se guardan siempre las tres claves (vacías si faltan).
 */
import { z } from "zod"
import { LANGUAGES, type Language } from "../model"

export interface MenuText {
  es: string
  ca: string
  en: string
}

/** Texto obligatorio (nombre de un plato, de una categoría…): el castellano no puede ir vacío. */
export function menuTextSchema(max: number) {
  const otro = z.string().trim().max(max, `Como mucho ${max} caracteres.`).default("")
  return z.object({
    es: z.string().trim().min(1, "Escribe el texto en castellano.").max(max, `Como mucho ${max} caracteres.`),
    ca: otro,
    en: otro,
  })
}

/** Texto opcional (descripción): puede ir vacío en los tres idiomas. */
export function optionalMenuTextSchema(max: number) {
  const campo = z.string().trim().max(max, `Como mucho ${max} caracteres.`).default("")
  return z.object({ es: campo, ca: campo, en: campo }).default({ es: "", ca: "", en: "" })
}

/** El texto en un idioma, o en castellano si falta. */
export function localize(text: MenuText, language: Language): string {
  const t = text[language].trim()
  return t !== "" ? t : text.es
}

/** Un texto solo en castellano (para datos de prueba y altas rápidas). */
export function textEs(es: string): MenuText {
  return { es, ca: "", en: "" }
}

/**
 * Idiomas que le faltan a un conjunto de textos (sin contar los que están vacíos también en
 * castellano, como una descripción que no existe). Sirve para el aviso «falta traducir».
 */
export function missingLanguages(texts: readonly MenuText[]): Language[] {
  const conTexto = texts.filter((t) => t.es.trim() !== "")
  return LANGUAGES.filter((lang) => lang !== "es" && conTexto.some((t) => t[lang].trim() === ""))
}
