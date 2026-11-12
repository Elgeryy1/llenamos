"use client"

import { ProhibitIcon } from "@phosphor-icons/react"
import { EmptyState } from "@/components/common/empty-state"
import { Button } from "@/components/ui/button"
import { signOut } from "@/lib/auth/AuthProvider"
import { StandaloneFrame } from "./PanelStates"

/** La cuenta sigue iniciada, pero ya no tiene ficha activa en este restaurante. */
export function PanelNoAccess({ restaurants, rid, storeRid }: { restaurants: { id: string; name: string }[]; rid: string | null; storeRid: (id: string) => void }) {
  const others = restaurants.filter((r) => r.id !== rid)
  return (
    <StandaloneFrame>
      <EmptyState
        icon={<ProhibitIcon />}
        title={`Ya no tienes acceso a ${restaurants.find((r) => r.id === rid)?.name ?? "este restaurante"}`}
        description="Tu cuenta está desactivada en este restaurante. Si es un error, habla con quien lo gestiona."
        action={
          <div className="flex flex-wrap justify-center gap-2">
            {others.map((r) => (
              <Button key={r.id} variant="outline" onClick={() => storeRid(r.id)}>
                Ir a {r.name}
              </Button>
            ))}
            <Button variant="ghost" onClick={() => void signOut()}>
              Salir
            </Button>
          </div>
        }
      />
    </StandaloneFrame>
  )
}
