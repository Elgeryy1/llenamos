import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { Activity, useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { useCloseOnHide } from "@/lib/open-state"
import { DataTable, DataTableColumnHeader, dataTableColumns } from "./data-table"
import { EmptyState } from "./empty-state"
import { SelectField, TextField } from "./form-fields"
import { LiveIndicator, LoadingBlock } from "./loading"
import { Notice } from "./notice"
import { estadoVisible, StatusDot } from "./reservation-status"
import { SegmentedControl } from "./segmented-control"
import { StatCard } from "./stat-card"
import { Tag } from "./tag"

describe("StatusDot y estadoVisible", () => {
  it("el estado se dice con palabra, no solo con color", () => {
    render(<StatusDot estado="sentada" />)
    expect(screen.getByText("Sentada").getAttribute("data-estado")).toBe("sentada")
  })

  it("una confirmada es «por llegar» hasta su hora y «retraso» después", () => {
    const inicio = Date.UTC(2026, 10, 9, 19, 30)
    expect(estadoVisible("confirmed", inicio, inicio - 60_000)).toEqual({ estado: "por_llegar", label: "Por llegar" })
    expect(estadoVisible("confirmed", inicio, inicio + 12 * 60_000)).toEqual({ estado: "retraso", label: "Retraso 12 min" })
    expect(estadoVisible("no_show", inicio, inicio).label).toBe("No se presentó")
    expect(estadoVisible("pending", inicio, inicio).estado).toBe("pendiente")
  })
})

describe("TextField y SelectField", () => {
  it("enlazan la etiqueta con el campo", () => {
    render(<TextField label="Correo" />)
    expect(screen.getByLabelText("Correo").tagName).toBe("INPUT")
  })

  it("marcan el error y lo enlazan para lectores de pantalla", () => {
    render(<TextField label="Correo" hint="Tu correo del trabajo" error="Ese correo no parece válido." />)
    const input = screen.getByLabelText("Correo")
    expect(input.getAttribute("aria-invalid")).toBe("true")
    const error = screen.getByRole("alert")
    expect(error.textContent).toBe("Ese correo no parece válido.")
    expect(input.getAttribute("aria-describedby")).toBe(error.id)
    expect(screen.queryByText("Tu correo del trabajo")).toBeNull()
  })

  it("sin error enseñan la ayuda", () => {
    render(
      <SelectField label="Rol" hint="Elige uno">
        <option>Camarero</option>
      </SelectField>,
    )
    const select = screen.getByLabelText("Rol")
    // Desplegable propio, no el del navegador.
    expect(select.getAttribute("role")).toBe("combobox")
    expect(document.getElementById(select.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Elige uno")
  })
})

describe("Notice, EmptyState, LoadingBlock, StatCard y Tag", () => {
  it("los errores se anuncian al momento y el resto como estado", () => {
    render(<Notice tone="error" title="No se ha podido guardar" detail="permission-denied">Sin permiso.</Notice>)
    expect(screen.getByRole("alert").textContent).toContain("permission-denied")
    render(<Notice tone="success">Guardado.</Notice>)
    expect(screen.getByRole("status").textContent).toBe("Guardado.")
  })

  it("el estado vacío explica y ofrece una acción", () => {
    render(<EmptyState title="Aún no hay actividad" description="Aparecerá aquí." action={<button>Invitar</button>} />)
    expect(screen.getByText("Aún no hay actividad")).toBeTruthy()
    expect(screen.getByRole("button", { name: "Invitar" })).toBeTruthy()
  })

  it("la carga se anuncia con texto", () => {
    render(<LoadingBlock label="Cargando el plano…" />)
    expect(screen.getByRole("status").textContent).toContain("Cargando el plano…")
  })

  it("la cifra y su etiqueta van juntas", () => {
    render(<StatCard label="Plazas" value={58} hint="en las mesas activas" />)
    expect(screen.getByText("58").className).toContain("cifra")
    expect(screen.getByText("Plazas")).toBeTruthy()
  })

  it("etiquetas y en directo enseñan su texto", () => {
    render(
      <>
        <Tag tone="alergia">Alergia a frutos secos</Tag>
        <LiveIndicator time="20:42" />
      </>,
    )
    expect(screen.getByText("Alergia a frutos secos").getAttribute("data-tone")).toBe("alergia")
    expect(screen.getByText("En directo")).toBeTruthy()
  })
})

describe("SegmentedControl", () => {
  it("elige una opción y no se queda sin ninguna", () => {
    const onChange = vi.fn()
    render(
      <SegmentedControl
        label="Turno"
        value="cena"
        onValueChange={onChange}
        options={[
          { value: "comida", label: "Comida" },
          { value: "cena", label: "Cena" },
          { value: "dia", label: "Todo el día" },
        ]}
      />,
    )
    const group = screen.getByRole("radiogroup", { name: "Turno" })
    fireEvent.click(within(group).getByRole("radio", { name: "Comida" }))
    expect(onChange).toHaveBeenCalledWith("comida")
    onChange.mockReset()
    fireEvent.click(within(group).getByRole("radio", { name: "Cena" }))
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe("DataTable", () => {
  type Fila = { id: string; nombre: string; visitas: number }
  const col = dataTableColumns<Fila>()
  const columns = [
    col.accessor("nombre", { header: ({ column }) => <DataTableColumnHeader column={column} title="Cliente" /> }),
    col.accessor("visitas", { header: ({ column }) => <DataTableColumnHeader column={column} title="Visitas" /> }),
  ]
  const data: Fila[] = [
    { id: "a", nombre: "Clara", visitas: 3 },
    { id: "b", nombre: "Ana", visitas: 12 },
  ]

  it("ordena al pulsar la cabecera y lo anuncia", () => {
    render(<DataTable columns={columns} data={data} getRowId={(f) => f.id} caption="Clientes" />)
    const nombres = () => screen.getAllByRole("row").slice(1).map((r) => within(r).getAllByRole("cell")[0]!.textContent)
    expect(nombres()).toEqual(["Clara", "Ana"])
    fireEvent.click(screen.getByRole("button", { name: /Cliente, ordenar ascendente/ }))
    expect(nombres()).toEqual(["Ana", "Clara"])
    expect(screen.getAllByRole("columnheader")[0]!.getAttribute("aria-sort")).toBe("ascending")
  })

  it("las filas se abren con clic o con Intro", () => {
    const onRowClick = vi.fn()
    render(<DataTable columns={columns} data={data} getRowId={(f) => f.id} onRowClick={onRowClick} rowLabel={(f) => `Abrir ${f.nombre}`} />)
    fireEvent.keyDown(screen.getByRole("row", { name: "Abrir Ana" }), { key: "Enter" })
    expect(onRowClick).toHaveBeenCalledWith(data[1])
  })

  it("sin filas lo dice", () => {
    render(<DataTable columns={columns} data={[]} getRowId={(f) => f.id} empty="Aún no hay clientes." />)
    expect(screen.getByText("Aún no hay clientes.")).toBeTruthy()
  })
})

describe("useCloseOnHide", () => {
  function Menu() {
    const [open, setOpen] = useState(true)
    useCloseOnHide(() => setOpen(false))
    return <p>{open ? "abierto" : "cerrado"}</p>
  }
  const Page = ({ hidden }: { hidden: boolean }) => (
    <Activity mode={hidden ? "hidden" : "visible"}>
      <Menu />
    </Activity>
  )

  it("cierra cuando Next oculta la página y no al montarse", async () => {
    const view = render(<Page hidden={false} />)
    await act(async () => {})
    expect(screen.getByText("abierto")).toBeTruthy()
    view.rerender(<Page hidden />)
    await act(async () => {})
    view.rerender(<Page hidden={false} />)
    await act(async () => {})
    expect(screen.getByText("cerrado")).toBeTruthy()
  })
})
