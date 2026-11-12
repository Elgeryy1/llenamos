export function ApiDocs({ restaurantId, locationId }: { restaurantId: string; locationId: string | null }) {
  const base = `/v1/restaurants/${restaurantId}/locations/${locationId ?? "ID_DEL_LOCAL"}`
  return <section className="superficie space-y-5 p-5" aria-labelledby="api-docs">
    <div><h2 id="api-docs" className="text-lg font-semibold">Documentación para desarrolladores</h2><p className="mt-1 text-sm text-muted-foreground">API de lectura v1. La clave solo permite los alcances y locales seleccionados. Los importes son céntimos enteros de euro.</p></div>
    <div className="overflow-x-auto"><table className="w-full text-left text-sm"><caption className="sr-only">Rutas de la API</caption><thead><tr className="border-b"><th className="p-2">Petición</th><th className="p-2">Alcance</th><th className="p-2">Respuesta</th></tr></thead><tbody>
      <tr className="border-b"><td className="p-2"><code>GET {base}/menu</code></td><td className="p-2"><code>menu.read</code></td><td className="p-2">Carta pública sin datos internos</td></tr>
      <tr><td className="p-2"><code>GET {base}/orders</code></td><td className="p-2"><code>orders.read</code></td><td className="p-2">Id, fecha, estado, total y referencias de líneas</td></tr>
    </tbody></table></div>
    <div><h3 className="font-medium">Autenticación y paginación</h3><p className="mt-1 text-sm text-muted-foreground">Envía Authorization: Bearer con tu clave. Usa limit entre 1 y 100 y devuelve nextCursor como cursor sin modificarlo. El cursor caduca en una hora y pertenece a esa clave, local y consulta. La carta se devuelve completa. Se permiten 60 peticiones por minuto y clave y 300 por restaurante.</p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-sunken p-4 text-xs"><code>{`curl "$BASE_URL${base}/orders?limit=25" \\\n  -H "Authorization: Bearer $LLENAMOS_API_KEY"`}</code></pre>
      <p className="mt-2 text-sm text-muted-foreground">BASE_URL es la URL de la función plataformaApi que facilite el operador. En local usa el emulador de Functions de esta instalación. Guarda la clave en el servidor de tu aplicación.</p></div>
    <div><h3 className="font-medium">Errores</h3><p className="mt-1 text-sm text-muted-foreground">400: entrada o cursor incorrectos. 401: clave inválida, caducada o revocada. 403: alcance, local o módulo denegado. 409: recurso todavía no disponible. 429: cuota de peticiones agotada, respeta Retry-After.</p></div>
    <div><h3 className="font-medium">Webhooks firmados</h3><p className="mt-1 text-sm text-muted-foreground">El cuerpo contiene id, type, version, restaurantId, locationId, occurredAt y data con entityId y status. No incluye contactos. Verifica Llenamos-Signature sobre los bytes recibidos antes de interpretar el JSON. Acepta una diferencia máxima de 300 segundos y guarda event.id con una restricción única antes de aplicar efectos.</p>
      <pre className="mt-3 overflow-x-auto rounded-lg bg-surface-sunken p-4 text-xs"><code>{`import { createHmac, timingSafeEqual } from "node:crypto"
// rawBody es un Buffer con los bytes originales.
const match = /^t=(\\d+),v1=([a-f0-9]{64})$/.exec(signature)
if (!match || Math.abs(Date.now() / 1000 - Number(match[1])) > 300)
  throw new Error("Firma caducada o incorrecta")
const expected = createHmac("sha256", secret)
  .update(match[1] + ".").update(rawBody).digest()
if (!timingSafeEqual(expected, Buffer.from(match[2], "hex")))
  throw new Error("Firma incorrecta")
// Deduplicar event.id de forma transaccional y responder 2xx.`}</code></pre>
      <p className="mt-2 text-sm text-muted-foreground">Cada intento renueva firma y fecha. 2xx confirma, 429 o 5xx reintenta hasta 12 veces, 410 revoca y otros 4xx suspenden para revisión. La repetición manual conserva el evento y el cuerpo. Tras rotar el secreto, usa la nueva versión.</p>
      <p className="mt-2 text-sm text-warning">Los eventos salen de reservas, sala, caja y suscripción en el mismo momento en que ocurre el hecho. En local el transporte normal bloquea salidas externas. La cola no acredita una entrega.</p></div>
  </section>
}
