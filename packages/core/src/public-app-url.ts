// core solo usa lib ES2022; URL existe en Node y en el navegador, así que basta con su forma mínima.
type ParsedUrl = { protocol: string; hostname: string; username: string; password: string; pathname: string; search: string; hash: string; origin: string }
const ParseUrl = (globalThis as unknown as { URL: new (input: string) => ParsedUrl }).URL

/** Origen explícito para enlaces públicos; nunca deducirlo del Host de una petición. */
export function publicAppOrigin(origin: string | undefined, demoEmulator = false): string {
  try {
    const url = new ParseUrl(origin?.trim() || (demoEmulator ? 'http://localhost:3000' : ''))
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (!demoEmulator && loopback)
      || (url.protocol !== 'https:' && !(demoEmulator && loopback && url.protocol === 'http:')))
      throw new Error()
    return url.origin
  } catch { throw new Error('Falta configurar el origen HTTPS de la aplicación.') }
}
