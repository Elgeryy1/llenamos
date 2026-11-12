# Capturas de sin conexión

Hechas a 2x con `scripts/sync-browser.ts` (Playwright, Chromium, `BrowserContext.setOffline`) contra los emuladores de la fila 3 y las cuentas de demo. El resumen de comprobaciones está en `resultados.json`.

- `comandero-pendiente.png`: comanda guardada en el dispositivo durante el corte, marcada como pendiente de sincronizar.
- `recarga-sin-red.png`: recarga sin internet; carcasa de recuperación con el número de pendientes.
- `cocina-pendiente.png`: cambio de estado de la estación guardado en local, pendiente.
- `caja-efectivo-local.png`: efectivo anotado sin crear cobro; tarjeta y fiscalidad bloqueadas.
- `conflicto-tableta.png`: conflicto visible entre dos tabletas, sin duplicar el pedido.
- `movil-otra-cuenta.png`: la cola pendiente queda oculta y bloqueada para otra cuenta.
