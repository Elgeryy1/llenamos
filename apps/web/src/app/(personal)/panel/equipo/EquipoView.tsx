"use client"

import { can, ROLE_LABEL, type Role } from "@llenamos/core"
import { CaretRightIcon, DotsThreeIcon, UserMinusIcon, UserPlusIcon, UsersThreeIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"
import { toast } from "sonner"
import { EmptyState } from "@/components/common/empty-state"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { Tag } from "@/components/common/tag"
import { LiveError } from "@/components/panel/LiveError"
import { PageHeading } from "@/components/common/page-heading"
import { usePanel } from "@/components/panel/PanelContext"
import { RequirePermission } from "@/components/panel/RequirePermission"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"
import { llamarFuncion } from "@/lib/data/functions"
import { useMembers } from "@/lib/data/hooks"
import type { MemberDoc } from "@/lib/data/parse"
import { describeError } from "@/lib/firebase/errors"
import { useCloseOnHide } from "@/lib/open-state"
import { initials, sortMembers, teamActions } from "@/lib/panel/equipo"
import { InvitarDialog } from "./InvitarDialog"

export function EquipoView() {
  return (
    <RequirePermission permission="equipo.ver" what="el equipo">
      <Equipo />
    </RequirePermission>
  )
}

function fail(title: string, e: unknown) {
  const info = describeError(e)
  toast.error(title, { description: info.code ? `${info.message} (${info.code})` : info.message })
}

function Equipo() {
  const { restaurant, member: me, role, locations } = usePanel()
  const members = useMembers(restaurant.id)
  const manages = can(role, "equipo.gestionar")

  const [inviteOpen, setInviteOpen] = useState(false)
  const [toDeactivate, setToDeactivate] = useState<MemberDoc | null>(null)
  const [busyUid, setBusyUid] = useState<string | null>(null)
  // Si Next oculta la página con <Activity>, al volver no debe quedar ninguna ventana abierta.
  useCloseOnHide(() => {
    setInviteOpen(false)
    setToDeactivate(null)
  })

  const locationNames = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations])
  const sorted = useMemo(() => (members.status === "ready" ? sortMembers(members.data) : []), [members])
  const active = sorted.filter((m) => m.active)
  const inactive = sorted.filter((m) => !m.active)

  async function changeRole(target: MemberDoc, next: Role) {
    if (next === target.role) return
    setBusyUid(target.uid)
    try {
      await llamarFuncion("cambiarRolMiembro", { restaurantId: restaurant.id, uid: target.uid, role: next })
      toast.success("Rol cambiado", { description: `${target.displayName} ahora es ${ROLE_LABEL[next].toLowerCase()}.` })
    } catch (e) {
      fail(`No se ha podido cambiar el rol de ${target.displayName}`, e)
    } finally {
      setBusyUid(null)
    }
  }

  async function deactivate(target: MemberDoc) {
    setBusyUid(target.uid)
    try {
      await llamarFuncion("desactivarMiembro", { restaurantId: restaurant.id, uid: target.uid })
      toast.success("Persona desactivada", { description: `${target.displayName} ya no puede entrar en ${restaurant.name}.` })
      setToDeactivate(null)
    } catch (e) {
      setToDeactivate(null)
      fail(`No se ha podido desactivar a ${target.displayName}`, e)
    } finally {
      setBusyUid(null)
    }
  }

  return (
    <>
      <PageHeading
        eyebrow={`${restaurant.name} · Equipo`}
        title={members.status === "ready" ? `${active.length} ${active.length === 1 ? "persona" : "personas"} en el equipo` : "Equipo"}
        description={`Quién trabaja en ${restaurant.name} y qué puede hacer.`}
        actions={
          <>
            {members.status === "ready" ? <LiveIndicator /> : null}
            {manages ? (
              <Button className="shadow-soft" size="lg" onClick={() => setInviteOpen(true)}>
                <UserPlusIcon aria-hidden data-icon="inline-start" />
                Invitar
              </Button>
            ) : null}
          </>
        }
      />

      {members.status === "loading" ? (
        <Card className="superficie rounded-[12px] shadow-soft ring-0 sm:rounded-[14px]">
          <CardContent>
            <LoadingBlock label="Cargando el equipo…" className="flex flex-col gap-4">
              {Array.from({ length: 4 }, (_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <Skeleton className="size-8 rounded-full" />
                  <div className="flex flex-1 flex-col gap-2">
                    <Skeleton className="h-4 w-40" />
                    <Skeleton className="h-3 w-56" />
                  </div>
                  <Skeleton className="h-8 w-28" />
                </div>
              ))}
            </LoadingBlock>
          </CardContent>
        </Card>
      ) : members.status === "error" ? (
        <LiveError title="No se ha podido cargar el equipo" error={members.error} />
      ) : active.length === 0 ? (
        <EmptyState
          icon={<UsersThreeIcon />}
          title="Aún no hay nadie en el equipo"
          description="Invita a tu gente para que pueda entrar al panel con su propia cuenta."
        />
      ) : (
        <div className="flex flex-col gap-6">
          <Card className="superficie gap-0 rounded-[12px] py-0 shadow-soft ring-0 sm:rounded-[14px]">
            <CardHeader className="border-b py-3">
              <CardTitle className="text-base font-semibold">
                Con acceso <span className="cifra text-muted-foreground">{active.length}</span>
              </CardTitle>
            </CardHeader>
            <ul className="divide-y">
              {active.map((m) => (
                <MemberRow
                  key={m.uid}
                  member={m}
                  actions={teamActions({ uid: me.uid, role }, m, sorted)}
                  isMe={m.uid === me.uid}
                  busy={busyUid === m.uid}
                  disabled={busyUid !== null}
                  locationNames={locationNames}
                  onRoleChange={(r) => void changeRole(m, r)}
                  onDeactivate={() => setToDeactivate(m)}
                />
              ))}
            </ul>
          </Card>

          {inactive.length > 0 ? (
            <Collapsible className="superficie group/inactivos">
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-sm font-medium hover:bg-muted/50 pointer-coarse:min-h-11"
                >
                  <span>
                    Desactivados <span className="cifra text-muted-foreground">{inactive.length}</span>
                  </span>
                  <CaretRightIcon aria-hidden className="size-4 text-muted-foreground transition-transform group-data-[state=open]/inactivos:rotate-90" />
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <ul className="divide-y border-t">
                  {inactive.map((m) => (
                    <MemberRow
                      key={m.uid}
                      member={m}
                      actions={teamActions({ uid: me.uid, role }, m, sorted)}
                      isMe={false}
                      busy={false}
                      disabled
                      locationNames={locationNames}
                      onRoleChange={() => {}}
                      onDeactivate={() => {}}
                    />
                  ))}
                </ul>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      )}

      {manages ? (
        <InvitarDialog
          open={inviteOpen}
          onClose={() => setInviteOpen(false)}
          restaurantId={restaurant.id}
          myRole={role}
          onInvited={(name, email, status) =>
            toast.success(`Invitación de ${name} ${status === "sent" ? "enviada" : "pendiente"}`, {
              description: status === "sent" ? `Se ha enviado a ${email}. Tendrá acceso cuando la acepte.` : "Falta configurar el correo de plataforma. La persona aún no tiene acceso.",
            })
          }
        />
      ) : null}

      <Dialog
        open={toDeactivate !== null}
        onOpenChange={(open) => {
          if (!open && !busyUid) setToDeactivate(null)
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{toDeactivate ? `¿Desactivar a ${toDeactivate.displayName}?` : "Desactivar"}</DialogTitle>
            <DialogDescription>Dejará de poder entrar en este restaurante. Su historial se queda en el registro de actividad.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={busyUid !== null}>
                Cancelar
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              disabled={busyUid !== null}
              aria-busy={(toDeactivate !== null && busyUid === toDeactivate.uid) || undefined}
              onClick={() => toDeactivate && void deactivate(toDeactivate)}
            >
              {toDeactivate !== null && busyUid === toDeactivate.uid ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
              Desactivar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}

function MemberRow({
  member,
  actions,
  isMe,
  busy,
  disabled,
  locationNames,
  onRoleChange,
  onDeactivate,
}: {
  member: MemberDoc
  actions: ReturnType<typeof teamActions>
  isMe: boolean
  busy: boolean
  disabled: boolean
  locationNames: ReadonlyMap<string, string>
  onRoleChange: (role: Role) => void
  onDeactivate: () => void
}) {
  const places =
    member.locationIds.length === 0
      ? "Todos los locales"
      : member.locationIds.map((id) => locationNames.get(id) ?? "otro local").join(", ")
  const lead = member.role === "owner" || member.role === "manager"

  return (
    <li className={cn("grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-3 gap-y-3 px-5 py-4 sm:flex sm:flex-wrap sm:gap-x-4", !member.active && "opacity-70")}>
      <Avatar className="size-10 ring-1 ring-border">
        <AvatarFallback className="bg-surface-raised text-xs font-semibold">{initials(member.displayName)}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex flex-wrap items-center gap-2 text-[15px] font-medium">
          {member.displayName}
          {isMe ? <Tag>Tú</Tag> : null}
          <span className={cn("inline-flex items-center gap-1.5 text-xs font-normal", member.active ? "text-success" : "text-muted-foreground")}><span aria-hidden className={cn("size-2 rounded-full", member.active ? "bg-success" : "bg-ash")} />{member.active ? "Activo" : "Desactivado"}</span>
        </p>
        <p className="truncate text-xs text-muted-foreground">
          <span className="cifra">{member.email}</span> · {places}
        </p>
        {actions.reason && member.active && !isMe ? <p className="mt-1 text-xs text-muted-foreground">{actions.reason}</p> : null}
      </div>

      <div className="col-start-2 flex flex-wrap items-center gap-2 sm:ml-auto">
        {busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden className="text-muted-foreground" /> : null}
        {actions.canChangeRole && member.active ? (
          <Select value={member.role} disabled={disabled} onValueChange={(v) => onRoleChange(v as Role)}>
            <SelectTrigger size="sm" className="w-36" aria-label={`Rol de ${member.displayName}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {actions.roleOptions.map((r) => (
                <SelectItem key={r} value={r}>
                  {ROLE_LABEL[r]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <Badge variant={lead ? "outline" : "secondary"} className={cn(lead && "border-primary/30 text-primary")}>
            {ROLE_LABEL[member.role]}
          </Badge>
        )}
        {actions.canDeactivate && member.active ? (
          <MemberMenu name={member.displayName} disabled={disabled} onDeactivate={onDeactivate} />
        ) : null}
      </div>
    </li>
  )
}

function MemberMenu({ name, disabled, onDeactivate }: { name: string; disabled: boolean; onDeactivate: () => void }) {
  const [open, setOpen] = useState(false)
  useCloseOnHide(() => setOpen(false))
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="pointer-coarse:size-11" disabled={disabled} aria-label={`Más acciones para ${name}`}>
          <DotsThreeIcon aria-hidden weight="bold" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem variant="destructive" onSelect={onDeactivate}>
          <UserMinusIcon aria-hidden />
          Desactivar a {name}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
