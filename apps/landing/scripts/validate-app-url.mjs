// La compilación debe fallar antes de publicar una presentación con un acceso roto.
import { loadEnv } from 'vite'
try {
  const url = new URL(loadEnv('production', process.cwd(), 'VITE_').VITE_APP_URL)
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error()
} catch {
  console.error('Configura VITE_APP_URL con el origen HTTPS de la aplicación antes de compilar.')
  process.exit(1)
}
