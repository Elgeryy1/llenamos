"use client"

import { StorefrontIcon } from "@phosphor-icons/react"
import type { User } from "firebase/auth"
import { useState, type FormEvent } from "react"
import { TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Spinner } from "@/components/ui/spinner"
import { signOut } from "@/lib/auth/AuthProvider"
import { CrearRestauranteInput, llamarFuncion } from "@/lib/data/functions"
import { describeError } from "@/lib/firebase/errors"
import { fieldErrors } from "@/lib/forms"
import { firstName } from "@/lib/format"

type FieldErrors = Partial<Record<"name" | "locationName", string>>

/**
 * Primera vez: la persona no está en ningún restaurante. En la demo puede crear el suyo; en el VPS el alta propia
 * está apagada (DECISIONES.md, 2026-11-12) y los restaurantes los da de alta LogiQD.
 */
export function CrearRestaurante({ user, onCreated }: { user: User; onCreated: (restaurantId: string) => void }) {
  if (process.env.NEXT_PUBLIC_DATA_BACKEND === "postgres") return <SinRestaurante user={user} />
  return <CrearRestauranteDemo user={user} onCreated={onCreated} />
}

function SinRestaurante({ user }: { user: User }) {
  const [error, setError] = useState<ReturnType<typeof describeError> | null>(null)
  const greeting = firstName(user.displayName)
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-muted text-primary">
          <StorefrontIcon className="size-4" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting ? `Hola, ${greeting}` : "Hola"}</h1>
        <p className="text-sm text-muted-foreground">
          Tu cuenta aún no forma parte de ningún restaurante. Si trabajas en uno, pide al propietario que te invite.
          Si el restaurante es tuyo, escríbenos a hola@logiqd.me y lo damos de alta con tu correo.
        </p>
      </div>
      {error ? <Notice tone="error" detail={error.code}>{error.message}</Notice> : null}
      <Button type="button" variant="outline" size="lg" className="self-start" onClick={() => void signOut().catch(e => setError(describeError(e)))}>Salir</Button>
    </div>
  )
}

function CrearRestauranteDemo({ user, onCreated }: { user: User; onCreated: (restaurantId: string) => void }) {
  const [name, setName] = useState("")
  const [locationName, setLocationName] = useState("")
  const [errors, setErrors] = useState<FieldErrors>({})
  const [error, setError] = useState<ReturnType<typeof describeError> | null>(null)
  const [pending, setPending] = useState(false)
  const [created, setCreated] = useState(false)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const parsed = CrearRestauranteInput.safeParse({ name, locationName })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, ["name", "locationName"]))
      return
    }
    setErrors({})
    setPending(true)
    try {
      const result = await llamarFuncion("crearRestaurante", parsed.data)
      onCreated(result.restaurantId)
      // El panel se abre solo cuando llega el perfil actualizado por el servidor.
      setCreated(true)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setPending(false)
    }
  }

  const greeting = firstName(user.displayName)

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <div aria-hidden className="flex size-9 items-center justify-center rounded-lg bg-muted text-primary">
          <StorefrontIcon className="size-4" />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight">{greeting ? `Hola, ${greeting}` : "Hola"}</h1>
        <p className="text-sm text-muted-foreground">
          Aún no formas parte de ningún restaurante. Si trabajas en uno, pide que te inviten. Si es tuyo, créalo
          aquí y quedarás como propietario.
        </p>
      </div>

      <Card>
        <CardContent>
      <form onSubmit={submit} noValidate className="flex flex-col gap-4">
        <TextField
          label="Nombre del restaurante"
          name="name"
          autoComplete="organization"
          placeholder="Taberna Lumbre"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          disabled={pending || created}
        />
        <TextField
          label="Nombre del primer local"
          name="locationName"
          placeholder="Centro"
          hint="Si tienes varios, luego podrás añadir el resto."
          value={locationName}
          onChange={(e) => setLocationName(e.target.value)}
          error={errors.locationName}
          disabled={pending || created}
        />
        {error ? (
          <Notice tone="error" detail={error.code}>
            {error.message}
          </Notice>
        ) : null}
        {created ? <Notice tone="success">Restaurante creado. Abriendo el panel…</Notice> : null}
        <Button type="submit" size="lg" disabled={pending || created} aria-busy={pending || undefined} className="self-start">
          {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
          {pending ? "Creando…" : "Crear restaurante"}
        </Button>
      </form>
        </CardContent>
      </Card>
    </div>
  )
}
