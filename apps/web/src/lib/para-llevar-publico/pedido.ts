import type { CallableInput } from "@llenamos/core"
import { callService } from "@/lib/carta/callables"
export const callTakeaway = <N extends "consultarRecogida" | "pedirParaLlevar" | "verParaLlevarPublico">(
  name: N,
  input: CallableInput<N>,
) => callService(name, input)
