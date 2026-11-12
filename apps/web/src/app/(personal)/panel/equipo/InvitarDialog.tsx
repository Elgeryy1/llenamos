"use client"

import { assignableRoles, ROLE_LABEL, type Role } from "@llenamos/core"
import { useState, type FormEvent } from "react"
import { SelectField, TextField } from "@/components/common/form-fields"
import { Notice } from "@/components/common/notice"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { FieldGroup } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { InvitarMiembroInput, llamarFuncion } from "@/lib/data/functions"
import { describeError, type ErrorInfo } from "@/lib/firebase/errors"
import { fieldErrors } from "@/lib/forms"

const FIELDS = ["displayName", "email", "role"] as const
type Field = (typeof FIELDS)[number]

export function InvitarDialog({
  open,
  onClose,
  restaurantId,
  myRole,
  onInvited,
}: {
  open: boolean
  onClose: () => void
  restaurantId: string
  myRole: Role
  onInvited: (name: string, email: string, status: "sent" | "pending") => void
}) {
  const roles = assignableRoles(myRole)
  const [displayName, setDisplayName] = useState("")
  const [email, setEmail] = useState("")
  const [role, setRole] = useState<Role>(roles.includes("waiter") ? "waiter" : (roles[0] ?? "waiter"))
  const [errors, setErrors] = useState<Partial<Record<Field, string>>>({})
  const [error, setError] = useState<ErrorInfo | null>(null)
  const [pending, setPending] = useState(false)

  function reset() {
    setDisplayName("")
    setEmail("")
    setErrors({})
    setError(null)
  }

  function close() {
    if (pending) return
    reset()
    onClose()
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    const parsed = InvitarMiembroInput.safeParse({ restaurantId, displayName, email, role })
    if (!parsed.success) {
      setErrors(fieldErrors(parsed.error, FIELDS))
      return
    }
    setErrors({})
    setPending(true)
    try {
      const result = await llamarFuncion("invitarMiembro", parsed.data)
      onInvited(parsed.data.displayName, parsed.data.email, result.invitationStatus)
      reset()
      onClose()
    } catch (e) {
      setError(describeError(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close()
      }}
    >
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invitar a alguien al equipo</DialogTitle>
          <DialogDescription>La persona elegirá su contraseña desde una invitación privada enviada a su correo. Hasta aceptarla no tendrá acceso al restaurante.</DialogDescription>
        </DialogHeader>
      <form id="invitar" onSubmit={submit} noValidate>
        <FieldGroup className="gap-4">
        <TextField
          label="Nombre"
          name="displayName"
          autoComplete="off"
          placeholder="Pau Soler"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          error={errors.displayName}
          disabled={pending}
        />
        <TextField
          label="Correo"
          type="email"
          name="email"
          autoComplete="off"
          inputMode="email"
          placeholder="pau@restaurante.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          disabled={pending}
        />
        <SelectField
          label="Rol"
          name="role"
          value={role}
          onChange={(e) => setRole(e.target.value as Role)}
          error={errors.role}
          disabled={pending}
          hint={myRole === "manager" ? "Como encargado puedes dar cualquier rol menos el de propietario." : undefined}
        >
          {roles.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABEL[r]}
            </option>
          ))}
        </SelectField>
        {error ? (
          <Notice tone="error" detail={error.code}>
            {error.message}
          </Notice>
        ) : null}
        </FieldGroup>
        <DialogFooter className="mt-4">
          <Button type="button" variant="outline" onClick={close} disabled={pending}>
            Cancelar
          </Button>
          <Button type="submit" disabled={pending} aria-busy={pending || undefined}>
            {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
            {pending ? "Invitando…" : "Invitar"}
          </Button>
        </DialogFooter>
      </form>
      </DialogContent>
    </Dialog>
  )
}
