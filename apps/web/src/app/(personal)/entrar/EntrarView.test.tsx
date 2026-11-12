import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { FirebaseError } from "firebase/app"
import { Activity } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { User } from "firebase/auth"
import type { AuthState } from "@/lib/auth/AuthProvider"

// La sesión, el router y Firebase se sustituyen: aquí solo importa cómo se
// comporta la página cuando Next la oculta y la vuelve a enseñar.
const mocks = vi.hoisted(() => ({
  auth: { status: "signedOut", byUser: false } as AuthState,
  replace: vi.fn(),
  signIn: vi.fn(),
  resetPassword: vi.fn(),
  params: new URLSearchParams(),
}))

vi.mock("@/lib/auth/AuthProvider", () => ({ useAuth: () => mocks.auth, signOut: vi.fn() }))
vi.mock("next/navigation", () => {
  const router = { replace: mocks.replace }
  return { useRouter: () => router, useSearchParams: () => mocks.params }
})
vi.mock("firebase/auth", () => ({ signInWithEmailAndPassword: mocks.signIn, sendPasswordResetEmail: mocks.resetPassword }))
vi.mock("@/lib/firebase/auth-client", () => ({
  getFirebaseIdentity: () => ({ auth: {} }),
  FirebaseConfigError: class extends Error {},
}))
vi.mock("@/lib/firebase/config", () => ({
  firebaseConfig: {
    ok: true,
    settings: { options: { projectId: "demo-llenamos" }, emulators: { host: "127.0.0.1", ports: { auth: 9099, firestore: 8085, functions: 5001, storage: 9199 } } },
  },
}))

const { EntrarView } = await import("./EntrarView")

// Lo que hace Next con cacheComponents: la ruta anterior queda montada y oculta.
function Page({ hidden }: { hidden: boolean }) {
  return (
    <Activity mode={hidden ? "hidden" : "visible"}>
      <EntrarView />
    </Activity>
  )
}

const signedIn = { status: "signedIn", user: { uid: "u1", getIdTokenResult: async () => ({ claims: {} }) } } as unknown as AuthState

describe("EntrarView", () => {
  beforeEach(() => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "firebase-demo")
    mocks.auth = { status: "signedOut", byUser: false }
    mocks.replace.mockReset()
    mocks.signIn.mockReset().mockResolvedValue({})
    mocks.resetPassword.mockReset().mockResolvedValue(undefined)
    mocks.params = new URLSearchParams()
  })
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it("al volver tras «Salir» deja entrar con otra cuenta", async () => {
    const view = render(<Page hidden={false} />)

    // Primera persona: entra con una cuenta de demostración y va al panel.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /propietario@lumbre.test/ }))
    })
    expect(mocks.signIn).toHaveBeenCalledWith({}, "propietario@lumbre.test", "Llenamos2026!")
    mocks.auth = signedIn
    view.rerender(<Page hidden={false} />)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/panel"))

    // Next oculta /entrar mientras se usa el panel.
    view.rerender(<Page hidden />)

    // Pulsa «Salir»: Next vuelve a enseñar la misma página, sin recargar.
    mocks.auth = { status: "signedOut", byUser: true }
    view.rerender(<Page hidden={false} />)

    expect(screen.queryByText("Entrando…")).toBeNull()
    expect(screen.getByRole("button", { name: "Entrar" }).hasAttribute("disabled")).toBe(false)
    expect((screen.getByLabelText("Correo") as HTMLInputElement).value).toBe("")
    expect((screen.getByLabelText("Contraseña") as HTMLInputElement).value).toBe("")

    const camarero = screen.getByRole("button", { name: /camarero@lumbre.test/ })
    expect(camarero.hasAttribute("disabled")).toBe(false)

    // La segunda persona entra y se va al panel otra vez.
    await act(async () => {
      fireEvent.click(camarero)
    })
    expect(mocks.signIn).toHaveBeenLastCalledWith({}, "camarero@lumbre.test", "Llenamos2026!")
    mocks.replace.mockReset()
    mocks.auth = signedIn
    view.rerender(<Page hidden={false} />)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/panel"))
  })

  it("si falla la entrada, se puede volver a intentar", async () => {
    mocks.signIn.mockRejectedValueOnce(new FirebaseError("auth/invalid-credential", "x"))
    render(<Page hidden={false} />)
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /cocina@lumbre.test/ }))
    })
    expect(screen.getByText("El correo o la contraseña no son correctos.")).toBeTruthy()
    expect(screen.getByRole("button", { name: /barra@lumbre.test/ }).hasAttribute("disabled")).toBe(false)
  })

  it("la entrada LogiQD no cambia los permisos de una cuenta normal", async () => {
    mocks.params = new URLSearchParams("acceso=logiqd&siguiente=/logiqd")
    mocks.auth = signedIn
    render(<Page hidden={false} />)
    expect(screen.getByRole("heading", { name: "Acceso LogiQD" })).toBeTruthy()
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/panel"))
  })

  it("envía recuperación sin confirmar si el correo está registrado", async () => {
    render(<Page hidden={false} />)
    fireEvent.change(screen.getByLabelText("Correo"), { target: { value: "equipo@restaurante.test" } })
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "He olvidado mi contraseña" })) })
    expect(mocks.resetPassword).toHaveBeenCalledWith({}, "equipo@restaurante.test")
    expect(screen.getByText(/Si el correo tiene una cuenta/)).toBeTruthy()
  })

  const sqlUser = (uid: string, claimedPlatform = false) => ({ uid, getIdToken: vi.fn(async () => `jwt-${uid}`), getIdTokenResult: vi.fn(async () => ({ claims: { logiqd: claimedPlatform } })) }) as unknown as User
  const sqlSession = (uid: string, access: "platform" | "restaurant", membership = true) => ({ uid, access, memberships: access === "platform" || !membership ? [] : [{ restaurantId: "r1", name: "Taberna", slug: "taberna", role: "waiter", locationIds: ["centro"] }] })
  const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })

  it("VPS abre administración por SQL aunque el token no tenga claim LogiQD", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    const user = sqlUser("admin")
    mocks.auth = { status: "signedIn", user }
    mocks.params = new URLSearchParams("siguiente=/panel/caja&acceso=trabajador")
    vi.stubGlobal("fetch", vi.fn(async () => reply(sqlSession("admin", "platform"))))
    render(<Page hidden={false} />)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/logiqd"))
    expect(user.getIdTokenResult).not.toHaveBeenCalled()
  })

  it("VPS ignora claim LogiQD e intención elegida si SQL da acceso de trabajador", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    const user = sqlUser("worker", true)
    mocks.auth = { status: "signedIn", user }
    mocks.params = new URLSearchParams("siguiente=/panel/cocina&acceso=logiqd")
    vi.stubGlobal("fetch", vi.fn(async () => reply(sqlSession("worker", "restaurant"))))
    render(<Page hidden={false} />)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/panel/cocina"))
    expect(user.getIdTokenResult).not.toHaveBeenCalled()
  })

  it.each(["no-memberships", "unbootstrapped", "revoked"])("VPS no redirige si SQL responde %s", async kind => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    mocks.auth = { status: "signedIn", user: sqlUser("u1", true) }
    vi.stubGlobal("fetch", vi.fn(async () => kind === "no-memberships" ? reply(sqlSession("u1", "restaurant", false)) : reply({ error: { code: kind === "revoked" ? "unauthenticated" : "permission-denied", message: kind === "revoked" ? "Tu sesión está revocada." : "La identidad no está provisionada en SQL." } }, 403)))
    render(<Page hidden={false} />)
    await waitFor(() => expect(screen.getByRole("button", { name: "Cerrar sesión y usar otra cuenta" })).toBeTruthy())
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(screen.queryByText("Sesión abierta. Comprobando acceso…")).toBeNull()
  })

  it("VPS cancela la comprobación previa al cambiar cuenta o cerrar sesión", async () => {
    vi.stubEnv("NEXT_PUBLIC_DATA_BACKEND", "postgres")
    let completeOld: (response: Response) => void = () => undefined
    const fetcher = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { completeOld = resolve })).mockImplementationOnce(async () => reply(sqlSession("new", "restaurant")))
    vi.stubGlobal("fetch", fetcher)
    mocks.auth = { status: "signedIn", user: sqlUser("old", true) }
    const view = render(<Page hidden={false} />)
    await waitFor(() => expect(fetcher).toHaveBeenCalledOnce())
    mocks.auth = { status: "signedIn", user: sqlUser("new") }
    view.rerender(<Page hidden={false} />)
    await waitFor(() => expect(mocks.replace).toHaveBeenCalledWith("/panel"))
    await act(async () => completeOld(reply(sqlSession("old", "platform"))))
    expect(mocks.replace).not.toHaveBeenCalledWith("/logiqd")
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true)
    mocks.auth = { status: "signedOut", byUser: true }
    view.rerender(<Page hidden={false} />)
    expect(screen.getByRole("button", { name: "Entrar" }).hasAttribute("disabled")).toBe(false)
  })
})
