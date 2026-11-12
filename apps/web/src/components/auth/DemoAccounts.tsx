"use client"

import { ROLE_LABEL } from "@llenamos/core"
import { ArrowRightIcon } from "@phosphor-icons/react"
import { Badge } from "@/components/ui/badge"
import { Item, ItemActions, ItemContent, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/cn"
import { DEMO_ACCOUNTS, type DemoAccount } from "@/lib/demo"

/** Lista de las cuentas de Taberna Lumbre para entrar con un clic (solo en local). Item de shadcn. */
export function DemoAccounts({
  onPick,
  pendingEmail,
  disabled,
}: {
  onPick: (account: DemoAccount) => void
  /** Cuenta con la que se está entrando ahora mismo. */
  pendingEmail: string | null
  disabled?: boolean
}) {
  return (
    <ItemGroup className="overflow-hidden rounded-xl border bg-card divide-y has-data-[size=sm]:gap-0">
      {DEMO_ACCOUNTS.map((account) => {
        const pending = pendingEmail === account.email
        return (
          <Item key={account.email} asChild size="sm" className={cn("rounded-none", pending && "bg-surface-raised")}>
            <button
              type="button"
              onClick={() => onPick(account)}
              disabled={disabled}
              aria-busy={pending || undefined}
              aria-label={`Entrar como ${ROLE_LABEL[account.role].toLowerCase()} con ${account.email}`}
              className="cursor-pointer text-left hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:min-h-11"
            >
              <Badge
                variant={account.role === "owner" || account.role === "manager" ? "outline" : "secondary"}
                className={cn("w-24 max-sm:w-auto", (account.role === "owner" || account.role === "manager") && "border-primary/30 text-primary")}
              >
                {ROLE_LABEL[account.role]}
              </Badge>
              <ItemContent className="min-w-0 max-sm:basis-48">
                <ItemTitle className="cifra w-full truncate text-[13px] font-normal">{account.email}</ItemTitle>
              </ItemContent>
              <ItemActions className="text-muted-foreground">
                {pending ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : <ArrowRightIcon aria-hidden className="size-4" />}
              </ItemActions>
            </button>
          </Item>
        )
      })}
    </ItemGroup>
  )
}
