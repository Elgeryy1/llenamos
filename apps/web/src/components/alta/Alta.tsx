import Link from "next/link"
import { Wordmark } from "@/components/Wordmark"
import { Button } from "@/components/ui/button"

/** El alta de restaurantes la gestiona LogiQD, nunca una cuenta pública. */
export function Alta() {
  return <main className="mx-auto flex min-h-svh max-w-lg flex-col justify-center gap-6 px-6 py-12">
    <Wordmark withBy />
    <h1 className="text-3xl font-semibold">Tu restaurante empieza con LogiQD</h1>
    <p className="text-muted-foreground">Preparamos tu restaurante con el plan y los módulos acordados y te enviamos una invitación personal. Si trabajas en un restaurante, pide acceso a su propietario.</p>
    <Button asChild><a href="mailto:hola@logiqd.me?subject=Alta%20de%20restaurante%20en%20Llenamos">Solicitar el alta</a></Button>
    <Button asChild variant="outline"><Link href="/entrar">Ya tengo una invitación o cuenta</Link></Button>
  </main>
}
