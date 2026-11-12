# Panel LogiQD, API y webhooks (fase 6, fila 3)

Capturas a 2x con los emuladores del agente 2 (proyecto demo-llenamos) y el recorrido de `scripts/plataforma-api-capturas.ts`. Los secretos que aparecen se crearon en el emulador y ya están revocados.

| Archivo | Qué muestra |
|---|---|
| `logiqd-escritorio.png` | Panel del equipo (claim logiqd): restaurantes, módulos activos, uso medido con fecha |
| `soporte-escritorio.png` | Ficha del restaurante: excepciones de módulos y acceso de soporte con motivo y caducidad |
| `integraciones-escritorio.png`, `integraciones-tableta.png`, `integraciones-movil.png` | Integraciones del restaurante: claves por alcance y local, webhooks, entregas y documentación para desarrolladores |
| `logiqd-denegado-movil.png` | Un propietario sin el claim no entra al panel del equipo |

El recorrido comprueba además: la clave se ve una sola vez, la ruta HTTP de carta responde 200 con ella y 401 tras revocarla.

Probar: `pnpm seed && pnpm seed:servicio`, luego `pnpm exec tsx scripts/plataforma-api-local.ts preparar-demo`, `publicar-demo` y `medir`; después `scripts/plataforma-api-capturas.ts` con la web en el puerto 3012 (cuentas equipo@logiqd.test y propietario@lumbre.test, contraseña Llenamos2026!).
