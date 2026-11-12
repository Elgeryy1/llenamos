// Solo configuración pública. Nunca leer ni mostrar secretos en el proceso de compilación.
const required = ['NEXT_PUBLIC_FIREBASE_PROJECT_ID', 'NEXT_PUBLIC_FIREBASE_API_KEY',
  'NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN',
  'NEXT_PUBLIC_FIREBASE_APP_ID', 'NEXT_PUBLIC_SITE_URL', 'VITE_APP_URL']
const problems = required.filter(key => !process.env[key]?.trim()).map(key => `Falta ${key}`)
if (/^(demo-|test-|fixture)/.test(process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID ?? '')) problems.push('Proyecto de prueba no permitido')
if (process.env.NEXT_PUBLIC_USE_EMULATORS !== '0') problems.push('Los emuladores deben estar desactivados')
if (process.env.NEXT_PUBLIC_DATA_BACKEND !== 'postgres') problems.push('El backend de producción debe ser PostgreSQL en el VPS')
for (const key of ['NEXT_PUBLIC_SITE_URL', 'VITE_APP_URL']) {
  try {
    const url = new URL(process.env[key])
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || url.hostname === 'localhost' || /^(127\.|0\.)/.test(url.hostname)) throw new Error()
  } catch { problems.push(`${key} debe ser un origen HTTPS público`) }
}
if (process.env.VITE_APP_URL !== process.env.NEXT_PUBLIC_SITE_URL) problems.push('Las URL de la aplicación deben coincidir')
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
