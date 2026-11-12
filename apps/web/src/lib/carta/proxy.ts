import { CALLABLE_SCHEMAS } from "@llenamos/core"
import { firebaseConfig } from "@/lib/firebase/config"

const allowed = [
  "guardarCategoriaCarta",
  "guardarPlato",
  "guardarMenuDia",
  "ordenarCarta",
  "marcarAgotado",
  "guardarEstacion",
  "guardarConfiguracionSala",
  "recuperarQrMesa",
  "revocarQrMesa",
  "importarQrMesa",
  "regenerarQrMesa",
  "verMesaPublica",
  "pedirDesdeMesa",
  "avisarDesdeMesa",
  "consultarRecogida",
  "pedirParaLlevar",
  "verParaLlevarPublico",
] as const
/** En local el 404 de Firebase no incluye CORS. Este puente permite distinguirlo de una caída de red. */
export async function proxyCallable(
  name: string,
  request: Request,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  const error = (status: number, code: string, message: string) =>
    Response.json({ error: { status: code, message } }, { status, headers: { "Cache-Control": "no-store" } })
  const callable = allowed.find((n) => n === name)
  if (!callable) return error(404, "NOT_FOUND", "Función no disponible en esta ruta.")
  if (!firebaseConfig.ok || !firebaseConfig.settings.emulators)
    return error(503, "CONFIG", "Este puente solo funciona con los emuladores locales.")
  const s = firebaseConfig.settings,
    e = s.emulators!
  let payload: unknown
  try {
    const raw = await request.text()
    if (raw.length > 250_000) return error(413, "INVALID_ARGUMENT", "El pedido es demasiado grande.")
    payload = JSON.parse(raw)
  } catch {
    return error(400, "INVALID_ARGUMENT", "Solicitud no válida.")
  }
  const parsed = CALLABLE_SCHEMAS[callable].input.safeParse((payload as { data?: unknown } | null)?.data)
  if (!parsed.success) return error(400, "INVALID_ARGUMENT", parsed.error.issues.map((i) => i.message).join(" "))
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const authorization = request.headers.get("authorization")
  if (authorization) headers.Authorization = authorization
  try {
    const upstream = await fetcher(
      `http://${e.host}:${e.ports.functions}/${s.options.projectId}/${s.region}/${callable}`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({ data: parsed.data }),
        signal: AbortSignal.timeout(19_000),
        cache: "no-store",
      },
    )
    const body = (await upstream.json().catch(() => null)) as { result?: unknown; error?: unknown } | null
    if (upstream.status === 404 && !body?.error)
      return error(404, "MISSING", `Falta el servidor de esta función: ${callable}.`)
    if (!body)
      return error(
        502,
        "UNCERTAIN",
        "No se ha recibido una respuesta válida. Consulta el estado antes de reenviar.",
      )
    return Response.json(body, { status: upstream.status, headers: { "Cache-Control": "no-store" } })
  } catch {
    return error(504, "UNCERTAIN", "No se ha recibido respuesta. Consulta el estado antes de reenviar.")
  }
}
