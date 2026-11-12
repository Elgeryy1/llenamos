import { ArrowRightIcon } from "@phosphor-icons/react/dist/ssr"
import Link from "next/link"
import { Wordmark } from "@/components/Wordmark"
import { Button } from "@/components/ui/button"

export default function Home() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="px-6 py-5">
        <Wordmark withBy />
      </header>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-6 px-6 pb-24">
        <h1 className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl">Llenamos tu sala.</h1>
        <p className="max-w-lg text-base text-muted-foreground">
          Reservas, sala y equipo de tu restaurante en un solo sitio. La página de reservas para tus clientes llega en
          la fase 1; el panel del personal ya está aquí.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <Button asChild size="lg">
            <Link href="/entrar">
              Entrar al panel
              <ArrowRightIcon aria-hidden />
            </Link>
          </Button>
          <Link href="/alta" className="inline-flex min-h-11 items-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground">
            ¿Tienes un restaurante? Pruébalo gratis
          </Link>
        </div>
      </main>
    </div>
  )
}
