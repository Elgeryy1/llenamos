"use client"

import { useState, type FormEvent } from "react"
import { useRouter } from "next/navigation"
import { signInWithEmailAndPassword, signOut } from "firebase/auth"
import { LoginLayout } from "@/components/auth/login-form"
import { TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { getFirebaseIdentity } from "@/lib/firebase/auth-client"
import { llamarFuncion } from "@/lib/data/functions"

export function AcceptInvitation() {
  const router = useRouter()
  const [password, setPassword] = useState("")
  const [repeat, setRepeat] = useState("")
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null)
    if (password.length < 12 || password !== repeat) { setError("Escribe una contraseña de al menos 12 caracteres y repítela igual."); return }
    setPending(true)
    try {
      const auth = getFirebaseIdentity().auth
      // La credencial de aceptación es el token privado, no una sesión anterior.
      await signOut(auth)
      const params = new URLSearchParams(window.location.hash.slice(1))
      const result = await llamarFuncion("aceptarInvitacion", { invitationId: params.get("i") ?? "", token: params.get("t") ?? "", password })
      const session = await signInWithEmailAndPassword(auth, result.email, password)
      await session.user.getIdToken(true)
      setPassword(""); setRepeat("")
      router.replace("/panel")
    } catch {
      setError("No se ha podido aceptar la invitación. Comprueba el enlace o solicita una invitación nueva si ha caducado.")
    } finally { setPending(false) }
  }
  return <LoginLayout footer="No compartas este enlace. Si no esperabas la invitación, puedes cerrar esta página.">
    <form onSubmit={submit} className="space-y-5">
      <div><h1 className="text-xl font-semibold">Aceptar tu invitación</h1><p className="mt-2 text-sm text-muted-foreground">Elige una contraseña que solo conozcas tú. Al aceptar confirmas este correo y entras en el equipo al que te han invitado.</p></div>
      <Notice tone="info">Si ya tienes una cuenta Llenamos, esta será su nueva contraseña para todos tus restaurantes y se cerrarán las sesiones anteriores.</Notice>
      <TextField label="Nueva contraseña" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={password} onChange={event => setPassword(event.target.value)} required disabled={pending} />
      <TextField label="Repetir contraseña" type="password" autoComplete="new-password" minLength={12} maxLength={128} value={repeat} onChange={event => setRepeat(event.target.value)} required disabled={pending} />
      {error ? <Notice tone="error">{error}</Notice> : null}
      <Button type="submit" disabled={pending}>{pending ? "Aceptando…" : "Aceptar invitación y entrar"}</Button>
    </form>
  </LoginLayout>
}
