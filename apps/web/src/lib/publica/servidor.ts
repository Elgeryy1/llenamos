/**
 * Datos de la web pública que se leen en el servidor de Next (páginas y metadatos).
 */
import { cacheLife } from "next/cache"
import { firebaseConfig } from "@/lib/firebase/config"
import { todayIn } from "./fechas"
import { fetchPublicRestaurantFromApi, type PublicRestaurantResult } from "./restaurante"

// La guarda va en línea para que el bundle `postgres` no incluya la lectura REST de Firestore de la demo.
const cargarRestauranteDemo = () => (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres" ? Promise.reject(new Error("Sin demo en el VPS.")) : import("./restaurante-demo"))

class Unavailable extends Error {}

/**
 * Se guarda unos segundos (perfil `seconds`) para que la página y sus metadatos lean una
 * sola vez y para aguantar picos de visitas. Un fallo de Firestore no se guarda: se lanza
 * dentro de la caché y se convierte en «no disponible» fuera.
 */
async function cachedRestaurant(slug: string): Promise<PublicRestaurantResult> {
  "use cache"
  cacheLife("seconds")
  const result =
    process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres"
      ? await fetchPublicRestaurantFromApi(slug)
      : await (await cargarRestauranteDemo()).fetchPublicRestaurant(slug, firebaseConfig.ok ? firebaseConfig.settings : null)
  if (result.status === "unavailable") throw new Unavailable(result.detail)
  return result
}

export async function getPublicRestaurant(slug: string): Promise<PublicRestaurantResult> {
  try {
    return await cachedRestaurant(slug)
  } catch (error) {
    return { status: "unavailable", detail: error instanceof Error ? error.message : "Sin respuesta." }
  }
}

/**
 * Día de hoy en el restaurante en el momento de la petición. Solo se llama después de
 * `connection()`, así que es la hora de cada visita y no la de cuando se compiló la página.
 */
export function requestToday(timezone: string): string {
  return todayIn(timezone, Date.now())
}
