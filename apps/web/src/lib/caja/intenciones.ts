import {
  CALLABLE_SCHEMAS_FASE3,
  type CallableInput,
  type CallableOutput,
} from "@llenamos/core"
import { esIncierto, llamarCaja, type NombreCaja } from "./api"

export type Intencion = { name: NombreCaja; input: unknown }
export type Resultado = { name: NombreCaja; data: unknown }
export interface Almacen {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** Una intención sin respuesta excluye las demás y conserva exactamente su requestId. */
export class IntencionesCaja {
  pending: Intencion | null = null
  busy = false
  constructor(
    private store: Almacen,
    private key: string,
    private send: typeof llamarCaja = llamarCaja,
  ) {
    const saved = store.getItem(key)
    if (saved) {
      const value = JSON.parse(saved) as Intencion
      if (!(value.name in CALLABLE_SCHEMAS_FASE3))
        throw new Error("No se reconoce la operación pendiente de caja.")
      this.pending = {
        name: value.name,
        input: CALLABLE_SCHEMAS_FASE3[value.name].input.parse(value.input),
      }
    }
  }
  async run<N extends NombreCaja>(
    name: N,
    input: Omit<CallableInput<N>, "requestId">,
  ): Promise<CallableOutput<N>> {
    if (this.busy || this.pending)
      throw new Error("Recupera primero la operación pendiente.")
    const parsed = CALLABLE_SCHEMAS_FASE3[name].input.parse({
      ...input,
      requestId: crypto.randomUUID(),
    })
    const intent: Intencion = { name, input: parsed }
    // Si no se puede guardar, no se envía un cobro que no podríamos recuperar.
    this.store.setItem(this.key, JSON.stringify(intent))
    this.pending = intent
    return (await this.retry()).data as CallableOutput<N>
  }
  async retry(): Promise<Resultado> {
    if (this.busy || !this.pending)
      throw new Error("No hay una operación pendiente que recuperar.")
    const intent = this.pending
    this.busy = true
    try {
      const data = await this.send(
        intent.name,
        intent.input as CallableInput<typeof intent.name>,
      )
      this.store.removeItem(this.key)
      this.pending = null
      return { name: intent.name, data }
    } catch (error) {
      if (!esIncierto(error)) {
        this.store.removeItem(this.key)
        this.pending = null
      }
      throw error
    } finally {
      this.busy = false
    }
  }
}
