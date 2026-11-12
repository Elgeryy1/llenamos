"use client"

import { EyeIcon, EyeSlashIcon } from "@phosphor-icons/react"
import { sendPasswordResetEmail, signInWithEmailAndPassword } from "firebase/auth"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useLayoutEffect, useState, type FormEvent } from "react"
import { DemoAccounts } from "@/components/auth/DemoAccounts"
import { ConfigProblems } from "@/components/panel/PanelStates"
import { LoginLayout } from "@/components/auth/login-form"
import { TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { FieldGroup } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { signOut, useAuth } from "@/lib/auth/AuthProvider"
import { DEMO_PASSWORD, type DemoAccount } from "@/lib/demo"
import { getFirebaseIdentity } from "@/lib/firebase/auth-client"
import { firebaseConfig } from "@/lib/firebase/config"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import { accountDestination, readAccountAccess } from "@/lib/auth/account-access"

export function EntrarFallback() {
  return (
    <LoginLayout>
      <div role="status" className="flex flex-col gap-4">
        <span className="sr-only">Cargando…</span>
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    </LoginLayout>
  )
}

export function EntrarView() {
  const auth = useAuth()
  const router = useRouter()
  const params = useSearchParams()
  const requested = params.get("siguiente")
  const entry = params.get("acceso")
  const title = entry === "logiqd" ? "Acceso LogiQD" : entry === "propietario" ? "Acceso de propietario" : entry === "trabajador" ? "Acceso del equipo" : "Entrar al panel"

  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [pendingEmail, setPendingEmail] = useState<string | null>(null)
  const [error, setError] = useState<ErrorInfo | null>(null)
  const [resetPending, setResetPending] = useState(false)
  const [resetSent, setResetSent] = useState(false)

  // Con cacheComponents, Next no desmonta esta página al entrar al panel: la deja
  // oculta con <Activity> y la vuelve a enseñar tal cual al pulsar «Salir». Sin
  // vaciarla, quedaba la cuenta anterior «entrando» y todo desactivado. La
  // limpieza del efecto de diseño corre justo al ocultarse.
  useLayoutEffect(
    () => () => {
      setEmail("")
      setPassword("")
      setShowPassword(false)
      setPendingEmail(null)
      setError(null)
      setResetSent(false)
      setResetPending(false)
    },
    [],
  )

  // Con sesión abierta no hay nada que hacer aquí.
  useEffect(() => {
    if (auth.status !== "signedIn") return
    const controller = new AbortController()
    void readAccountAccess(auth.user, { signal: controller.signal }).then(access => {
      if (!controller.signal.aborted) router.replace(accountDestination(access, requested))
    }).catch(error => { if (!controller.signal.aborted) setError(describeError(error)) })
    return () => controller.abort()
  }, [auth, requested, router])

  async function resetPassword() {
    if (!email.trim()) { setError({ message: "Escribe tu correo para recuperar el acceso." }); return }
    setResetPending(true); setError(null); setResetSent(false)
    try { await sendPasswordResetEmail(getFirebaseIdentity().auth, email.trim()); setResetSent(true) }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "auth/user-not-found") setResetSent(true)
      else setError(describeError(error))
    } finally { setResetPending(false) }
  }

  async function signIn(withEmail: string, withPassword: string) {
    setError(null)
    setPendingEmail(withEmail)
    try {
      await signInWithEmailAndPassword(getFirebaseIdentity().auth, withEmail.trim(), withPassword)
      // La redirección la hace el efecto de arriba al cambiar la sesión.
    } catch (e) {
      setError(describeError(e))
      setPendingEmail(null)
    }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!email.trim() || !password) {
      setError({ message: "Escribe tu correo y tu contraseña." })
      return
    }
    void signIn(email, password)
  }

  function pickDemo(account: DemoAccount) {
    setEmail(account.email)
    setPassword(DEMO_PASSWORD)
    void signIn(account.email, DEMO_PASSWORD)
  }

  if (auth.status === "misconfigured") {
    return (
      <LoginLayout>
        <ConfigProblems problems={auth.problems} />
      </LoginLayout>
    )
  }

  const busy = resetPending || pendingEmail !== null || auth.status === "loading" || auth.status === "signedIn"
  const formPending = pendingEmail !== null && pendingEmail === email.trim()
  const emulators = firebaseConfig.ok ? firebaseConfig.settings.emulators : null

  return (
    <LoginLayout
      aside={
        emulators ? (
          <div className="flex flex-col gap-4">
            <div>
              <p className="mb-2 flex items-center gap-2 text-xs text-success"><span aria-hidden className="size-2 rounded-full bg-success" />Entorno local</p>
              <h2 className="text-lg font-semibold">Prueba con tu equipo</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Elige un puesto en Taberna Lumbre. Todas las cuentas usan la contraseña{" "}
                <span className="cifra text-foreground">{DEMO_PASSWORD}</span>. Los datos y los mensajes se quedan en este entorno local.
              </p>
            </div>
            <DemoAccounts onPick={pickDemo} pendingEmail={pendingEmail} disabled={busy} />
          </div>
        ) : undefined
      }
      footer={
        <>
          LogiQD da de alta tu restaurante. Si eres trabajador, pide una invitación al propietario.
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        <FieldGroup>
          <div className="flex flex-col gap-1">
            <h1 className="text-[24px] leading-tight font-semibold tracking-tight text-balance sm:text-[32px]">{title}</h1>
            <p className="text-sm text-balance text-muted-foreground">Usa tu cuenta personal. Tu acceso depende de los permisos de tu cuenta.</p>
          </div>
          <TextField
            label="Correo"
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            placeholder="tu@restaurante.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={busy}
          />
          <TextField
            label="Contraseña"
            type={showPassword ? "text" : "password"}
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            disabled={busy}
            trailing={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="pointer-coarse:size-11"
                onClick={() => setShowPassword((s) => !s)}
                aria-label={showPassword ? "Ocultar contraseña" : "Ver contraseña"}
                aria-pressed={showPassword}
              >
                {showPassword ? <EyeSlashIcon aria-hidden /> : <EyeIcon aria-hidden />}
              </Button>
            }
          />
          {error ? (
            <Notice tone="error" detail={error.code}>
              {error.message}
            </Notice>
          ) : null}
          {auth.status === "signedIn" && !error ? <Notice tone="success">Sesión abierta. Comprobando acceso…</Notice> : null}
          {auth.status === "signedIn" && error ? <Button type="button" variant="outline" onClick={() => void signOut().catch(error => setError(describeError(error)))}>Cerrar sesión y usar otra cuenta</Button> : null}
          {resetSent ? <Notice tone="success">Si el correo tiene una cuenta, recibirás las instrucciones para recuperar tu contraseña.</Notice> : null}
          <Button type="submit" size="lg" disabled={busy} aria-busy={formPending || undefined} className="h-12 w-full shadow-soft">
            {formPending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
            {formPending ? "Entrando…" : "Entrar"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={() => void resetPassword()}>He olvidado mi contraseña</Button>
        </FieldGroup>
      </form>
    </LoginLayout>
  )
}
