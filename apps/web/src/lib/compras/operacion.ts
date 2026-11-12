import type { CallableInput, CallableOutput } from "@llenamos/core"
import { esDefinitivo, llamarCompras, type NombreCompras } from "./api"

/** Las que escriben: llevan `requestId`. La sugerencia solo lee y no lo admite. */
export type NombreMutacion = Exclude<NombreCompras, "sugerirPedidos">

/**
 * Reparte el `requestId` de cada intención. Si una llamada acaba en un error que no dice qué
 * pasó (red, tiempo agotado), el siguiente intento con exactamente la misma entrada reutiliza
 * el identificador y el servidor devuelve el resultado original sin repetir efectos. Con otra
 * entrada, o tras un éxito o un rechazo claro, se estrena identificador.
 */
export class Intenciones {
  private pendiente: { name: NombreMutacion; huella: string; requestId: string } | null = null
  constructor(
    private enviar: typeof llamarCompras = llamarCompras,
    private nuevoId: () => string = () => crypto.randomUUID(),
  ) {}

  async run<N extends NombreMutacion>(name: N, input: Omit<CallableInput<N>, "requestId">): Promise<CallableOutput<N>> {
    const huella = JSON.stringify(input)
    const requestId =
      this.pendiente && this.pendiente.name === name && this.pendiente.huella === huella ? this.pendiente.requestId : this.nuevoId()
    this.pendiente = { name, huella, requestId }
    try {
      const out = await this.enviar(name, { ...input, requestId } as CallableInput<N>)
      this.pendiente = null
      return out
    } catch (error) {
      if (esDefinitivo(error)) this.pendiente = null
      throw error
    }
  }
}
