import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const activity = vi.fn()
vi.mock("@/lib/data/hooks", () => ({ useActivity: (...a: unknown[]) => activity(...a) }))
vi.mock("@/components/panel/PanelContext", () => ({ usePanel: () => ({ restaurant: { id: "r1", name: "La Taberna" }, role: "owner" }) }))
vi.mock("@/components/panel/RequirePermission", () => ({ RequirePermission: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
import { ActividadView } from "./ActividadView"

beforeEach(() => { vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres"); activity.mockReset() })
afterEach(() => vi.unstubAllEnvs())

describe("Actividad en el VPS", () => {
  it("dice con claridad que no hay registro común, sin error ni consulta", () => {
    render(<ActividadView />)
    expect(screen.getByText("Aquí todavía no hay un registro común")).not.toBeNull()
    expect(screen.queryByText(/No se ha podido cargar/)).toBeNull()
    expect(activity).not.toHaveBeenCalled()
  })
})
