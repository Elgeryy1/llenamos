import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AuthState } from "@/lib/auth/AuthProvider"

// Producción en el VPS: la configuración sale de las variables públicas reales del proyecto `llenamos-logiqd`
// (sin simular `config`); solo se sustituye el SDK de Auth para no salir a la red.
const mocks = vi.hoisted(() => ({
  auth: { status: "signedOut", byUser: false } as AuthState,
  signIn: vi.fn(),
  resetPassword: vi.fn(),
  initializeApp: vi.fn(() => ({ options: { projectId: "llenamos-logiqd" } })),
}))

vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: () => mocks.auth, signOut: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: vi.fn() }), useSearchParams: () => new URLSearchParams() }))
vi.mock("firebase/app", () => ({ getApps: () => [], getApp: vi.fn(), initializeApp: mocks.initializeApp }))
vi.mock("firebase/auth", () => ({ getAuth: () => ({ emulatorConfig: null }), connectAuthEmulator: vi.fn(), signInWithEmailAndPassword: mocks.signIn, sendPasswordResetEmail: mocks.resetPassword }))

async function cargar() {
  vi.resetModules()
  vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
  vi.stubEnv("NEXT_PUBLIC_USE_EMULATORS", "0")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "llenamos-logiqd")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_API_KEY", "clave-publica")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN", "llenamos-logiqd.firebaseapp.com")
  vi.stubEnv("NEXT_PUBLIC_FIREBASE_APP_ID", "1:844781008037:web:74dee224fcac157c51894c")
  const { EntrarView } = await import("./EntrarView")
  const { firebaseConfig } = await import("@/lib/firebase/config")
  return { EntrarView, firebaseConfig }
}

describe("EntrarView en el VPS", () => {
  beforeEach(() => {
    mocks.auth = { status: "signedOut", byUser: false }
    mocks.signIn.mockReset().mockResolvedValue({})
    mocks.resetPassword.mockReset().mockResolvedValue(undefined)
    delete (globalThis as { __llenamosFirebaseIdentity?: unknown }).__llenamosFirebaseIdentity
  })
  afterEach(() => vi.unstubAllEnvs())

  it("la configuración real apunta a llenamos-logiqd sin emuladores y no ofrece cuentas demo", async () => {
    const { EntrarView, firebaseConfig } = await cargar()
    expect(firebaseConfig.ok && firebaseConfig.settings.emulators).toBeNull()
    expect(firebaseConfig.ok && firebaseConfig.settings.options.projectId).toBe("llenamos-logiqd")
    render(<EntrarView />)
    expect(screen.queryByText(/Prueba con tu equipo/)).toBeNull()
    expect(screen.queryByText(/Llenamos2026/)).toBeNull()
  })

  it("entra con la cuenta escrita contra la identidad del proyecto", async () => {
    const { EntrarView } = await cargar()
    render(<EntrarView />)
    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: " dueña@restaurante.test " } })
    fireEvent.change(screen.getByLabelText("Contraseña"), { target: { value: "una-contraseña-larga" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Entrar" })) })
    expect(mocks.initializeApp).toHaveBeenCalledWith(expect.objectContaining({ projectId: "llenamos-logiqd", apiKey: "clave-publica" }))
    expect(mocks.signIn).toHaveBeenCalledWith(expect.anything(), "dueña@restaurante.test", "una-contraseña-larga")
  })

  it("la recuperación responde lo mismo con una cuenta que existe y con una que no", async () => {
    const { EntrarView } = await cargar()
    const aviso = async (correo: string, fallo?: unknown) => {
      const vista = render(<EntrarView />)
      if (fallo) mocks.resetPassword.mockRejectedValueOnce(fallo)
      fireEvent.change(screen.getByLabelText("Correo"), { target: { value: correo } })
      await act(async () => { fireEvent.click(screen.getByRole("button", { name: "He olvidado mi contraseña" })) })
      const texto = screen.getByText(/Si el correo tiene una cuenta/).textContent
      vista.unmount()
      return texto
    }
    const existe = await aviso("dueña@restaurante.test")
    const noExiste = await aviso("nadie@restaurante.test", { code: "auth/user-not-found" })
    expect(existe).toBe(noExiste)
    expect(mocks.resetPassword).toHaveBeenCalledTimes(2)
  })

  it("la recuperación sin correo lo pide y no llama a Auth", async () => {
    const { EntrarView } = await cargar()
    render(<EntrarView />)
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "He olvidado mi contraseña" })) })
    expect(screen.getByText("Escribe tu correo para recuperar el acceso.")).toBeTruthy()
    expect(mocks.resetPassword).not.toHaveBeenCalled()
  })
})
