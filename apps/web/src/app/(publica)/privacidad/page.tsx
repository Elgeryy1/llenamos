import { notFound } from "next/navigation"

/** La política comercial debe tener su texto y URL aprobados antes de activar las casillas. */
export default function PrivacidadDemo() {
  if (process.env.NEXT_PUBLIC_USE_EMULATORS !== "1") notFound()
  return <main className="mx-auto max-w-2xl space-y-5 p-6 py-12"><h1 className="text-3xl font-semibold">Privacidad de la demostración local</h1><p>Versión demo-2026.1. Los datos de esta demostración se guardan en los emuladores locales de Llenamos. No se envían novedades reales.</p><p>Reservar no obliga a aceptar novedades. Cada canal tiene su casilla opcional y desmarcada. El enlace de baja de cada mensaje permite retirar el permiso de ese canal.</p><p>El restaurante puede tramitar la exportación y la supresión desde Privacidad. Este texto sirve para probar el recorrido local; el propietario debe aprobar su política antes de publicar las casillas.</p></main>
}
