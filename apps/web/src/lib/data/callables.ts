/**
 * Llamadas a las callables de la fase 1 con los esquemas de `@llenamos/core`
 * (`CALLABLE_SCHEMAS`): la entrada se valida aquí antes de llamar (el servidor la
 * vuelve a validar) y la salida se comprueba al recibirla. Espera 20 segundos como
 * máximo, como el resto del panel.
 */
import {
  CALLABLE_SCHEMAS,
  type CallableInput,
  type CallableOutput,
  type CallableWithSchema,
} from "@llenamos/core"
import { dataBackend } from "@/lib/api/config"
import { postOperation } from "@/lib/api/transport"
import { firebaseConfig } from "@/lib/firebase/config"
import { cargarClienteDemo, cargarFunctions } from "@/lib/firebase/cargar-demo"

const TIMEOUT_MS = 20_000

/** Valida la entrada sin llamar a nada. Lanza ZodError si no es válida. */
export function validarEntradaCore<N extends CallableWithSchema>(name: N, input: CallableInput<N>): unknown {
  return CALLABLE_SCHEMAS[name].input.parse(input)
}

/** Respuesta del servidor que no encaja con el contrato. */
export class RespuestaInesperadaError extends Error {
  constructor(readonly callable: string) {
    super(`El servidor ha respondido a ${callable} con un formato inesperado.`)
    this.name = "RespuestaInesperadaError"
  }
}

export async function llamarCore<N extends CallableWithSchema>(name: N, input: CallableInput<N>): Promise<CallableOutput<N>> {
  const data = validarEntradaCore(name, input)
  const settings = firebaseConfig.ok ? firebaseConfig.settings : null
  const backend = dataBackend(settings)
  let result: unknown
  if (backend === "postgres") {
    result = await postOperation(name, data, { authentication: "required", timeoutMs: TIMEOUT_MS })
  } else {
    // Compatibilidad exclusivamente local mientras se portan módulos; nunca fallback por fallo de API.
    const [{ httpsCallable }, { getFirebase }] = await Promise.all([cargarFunctions(), cargarClienteDemo()])
    const callable = httpsCallable<unknown, unknown>(getFirebase().functions, name, { timeout: TIMEOUT_MS })
    result = (await callable(data)).data
  }
  const parsed = CALLABLE_SCHEMAS[name].output.safeParse(result)
  if (!parsed.success) throw new RespuestaInesperadaError(name)
  return parsed.data as CallableOutput<N>
}
