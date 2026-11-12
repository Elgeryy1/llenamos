"use client"

// Bloque sidebar-07 de shadcn (nav-user): la persona que ha entrado y «Salir».
import { ROLE_LABEL } from "@llenamos/core"
import { BuildingsIcon, CaretUpDownIcon, SignOutIcon } from "@phosphor-icons/react"
import Link from "next/link"
import { useState } from "react"
import { usePanel } from "@/components/panel/PanelContext"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar } from "@/components/ui/sidebar"
import { signOut } from "@/lib/auth/AuthProvider"
import { useAccountAccess } from "@/lib/auth/account-access"
import { useCloseOnHide } from "@/lib/open-state"
import { initials } from "@/lib/panel/equipo"

export function NavUser() {
  const { isMobile } = useSidebar()
  const { member, role, user } = usePanel()
  const [open, setOpen] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const access = useAccountAccess(user)
  const isTeam = access.status === "ready" && access.data.access === "platform"
  useCloseOnHide(() => setOpen(false))

  const who = (
    <>
      <Avatar className="size-8 rounded-lg">
        <AvatarFallback className="rounded-lg bg-surface-raised text-xs font-semibold text-soft-foreground">{initials(member.displayName)}</AvatarFallback>
      </Avatar>
      <div className="grid flex-1 text-left text-sm leading-tight">
        <span className="truncate font-medium">{member.displayName}</span>
        <span className="truncate text-xs text-muted-foreground">{ROLE_LABEL[role]}</span>
      </div>
    </>
  )

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu open={open} onOpenChange={setOpen}>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              aria-label={`Tu cuenta: ${member.displayName}, ${ROLE_LABEL[role].toLowerCase()}`}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              {who}
              <CaretUpDownIcon className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-56" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuLabel className="p-0 font-normal">
              <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">{who}</div>
              <p className="cifra truncate px-1 pb-1 text-xs text-muted-foreground">{member.email}</p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {isTeam ? (
              <DropdownMenuItem asChild>
                <Link href="/logiqd">
                  <BuildingsIcon />
                  Equipo LogiQD
                </Link>
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem
              disabled={leaving}
              onSelect={() => {
                setLeaving(true)
                signOut().catch(() => setLeaving(false))
              }}
            >
              <SignOutIcon />
              {leaving ? "Saliendo…" : "Salir"}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  )
}
