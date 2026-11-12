import { describe, expect, it } from "vitest"

import { leerOpciones } from "./desplegable"

describe("leerOpciones", () => {
  it("lee opciones sueltas, grupos, fragmentos y desactivadas como un select", () => {
    const grupos = leerOpciones(
      <>
        <option value="">Elige una hora</option>
        <optgroup label="Comida">
          <option value="13:00">13:00</option>
          <option value="13:15" disabled>
            13:15 · completo
          </option>
        </optgroup>
        {[<option key="x">Sin valor</option>]}
      </>,
    )
    expect(grupos.map((g) => g.label)).toEqual([null, "Comida", null])
    expect(grupos[0].options[0]).toMatchObject({ value: "", disabled: false })
    expect(grupos[1].options.map((o) => [o.value, o.disabled])).toEqual([
      ["13:00", false],
      ["13:15", true],
    ])
    expect(grupos[2].options[0].value).toBe("Sin valor")
  })
})
