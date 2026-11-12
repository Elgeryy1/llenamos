# Comprobaciones del cierre de fase 5

2026-11-10. Rama `fase5/cierre`, worktree propio y proyecto `demo-llenamos`. Emuladores de la fila 2 y web 3012. Sin servicios, mensajes, tarjetas, pagos ni cuentas reales. Sin dependencias nuevas, cambios de firmas de core o cambios del catálogo comercial.

## Resultados

| Comprobación | Resultado |
|---|---|
| `pnpm lint && pnpm typecheck && pnpm test && pnpm build` | Verde; core 609, web 646 y functions 129 pruebas normales |
| Reglas de Firestore y Storage | 155 pruebas, 12 archivos, en verde |
| Fase 5, privacidad y copias | 49 pruebas, 7 archivos, en verde; `--only auth,firestore,storage` y clave local de custodia |
| Negocio de fases 2, 3 y 4, impresión, móvil, API y sincronización | 213 pruebas en verde, 20 archivos; disparadores pausados durante esta tanda |
| Alta, Billing y plataforma con Functions | 21 pruebas en verde; la prueba de custodia se omite aquí y privacidad y copias se verifican en la tanda aislada |
| Reservas, lista de espera, mensajes y señal | 14 pruebas en verde, con Functions y los secretos ficticios de los webhooks locales |
| Disparador de inventario | Una prueba real en verde con `TEST_FIREBASE_TRIGGERS=1`; los otros nueve casos del archivo ya están incluidos en la tanda de negocio |
| Navegador de fase 5 | Recorrido completado, 22 capturas a 2x y aserciones en `resultado.json` |
| Widget en contenedor HTML aislado | Reserva real, origen de campaña, dominio del padre, permiso por WhatsApp y cancelación; cero errores de página |
| Script del recorrido | TypeScript estricto verificado también fuera de la configuración de las aplicaciones |
| Limpieza | Los diez puertos de la fila 2 quedan libres, incluida la web; procesos propios detenidos por PID |

Las pruebas normales omiten las suites de integración por sus variables de entorno. No se cuentan como ejecutadas en la primera fila: las tandas siguientes las verifican expresamente. Las pruebas se ejecutan por tandas para que la carga masiva de fixtures no sature la cola de disparadores y no se mezcle con el recorrido de navegador. La limpieza del test de reservas pausa los disparadores cuando se proporciona `FIREBASE_EMULATOR_HUB`, evitando generar servicio mientras elimina su árbol de prueba.

## Recorrido y resultados observados

El script [fase5-navegador-integracion.ts](../../../../scripts/fase5-navegador-integracion.ts) usa Chromium real, Auth, Firestore, Functions, Storage y el doble HTTP de Repite. La reserva, la aceptación de novedades y la baja usan la interfaz pública. Las mutaciones de personal llaman al servidor por HTTP desde el navegador; las pantallas muestran las suscripciones y respuestas reales. Solo el contenedor HTML del widget es un fixture, sin interceptar sus llamadas ni las respuestas del producto.

- Reserva desde campaña: origen y un consentimiento por correo en la misma transacción. Casillas inicialmente vacías.
- Sentar y cobrar la visita: un sello confirmado en Repite, sin duplicación al cobrar.
- Promoción: descuento de 650 céntimos sobre 6500; cobro final de 5850 y 58 puntos.
- Otra visita: canje de 30 puntos; una devolución parcial de 1000 céntimos retira 10 puntos.
- Campaña: un destinatario con permiso, dos exclusiones sin permiso, envío capturado y cancelación de lo pendiente al darse de baja.
- Origen, ventas con comparativa y margen histórico, previsión con muestras, resumen diario capturado y recomendación descartada sin ejecutar nada.
- Menú de propietario y encargado con fase 5, camarero, cocina y barra sin sus entradas de gestión, y plan sala sin ninguna entrada de fase 5.
- Privacidad: solicitud completada, cuenta de puntos cerrada, enlace Repite eliminado y operación `remove_card` con destino conservado. Análisis legible después de la supresión.
- Widget real: `source: widget`, campaña y dominio del contenedor guardados, un consentimiento por WhatsApp y reserva cancelada al terminar la prueba.

## Arreglos encontrados al integrar

- Origen y permisos descartados por los escritores anteriores: se guardan ahora en la transacción de reserva, sin atribuir permisos a teléfono, importación o lista de espera.
- Envío común: comprueba el permiso antes de reclamar, conserva el marketing pendiente con su módulo apagado y libera el lease si una baja canceló el envío mientras esperaba respuesta.
- WhatsApp: palabras de baja normalizadas, retirada del canal una sola vez y cancelación de pendientes.
- Repite: los reintentos de retirada conservan tarjeta y comercio después de eliminar el enlace local.
- Privacidad: adaptadores de fidelización, campañas, revisión de devolución, enlace de sesión, costes y movimientos; respuestas idempotentes saneadas y no recuperables como operaciones nuevas.
- Histórico anonimizado: conserva nombres de platos multilingües y motivos técnicos válidos para seguir leyendo sala, caja y análisis. Los consentimientos saneados siguen cumpliendo su esquema y los eventos suprimidos dejan de recomendar.
- Paginación: el cursor recorre el orden del plan, sin saltar ids que mezclan mayúsculas y minúsculas. Prueba de reanudación con todos esos documentos revisados.
- Inventario grande: lecturas en grupos acotados dentro del mismo snapshot, sin serializar cada hoja del restaurante.
- Ficha: formularios de preferencias y puntos independientes, sin anidar formularios. Sello manual disponible para la reserva sentada.
- Campañas: la lectura de ajustes admite autor y fechas del servidor, manteniendo estricta la entrada callable. Los datos reales son la vista por defecto.
- Pruebas de móvil: ya no dependen exclusivamente de la fila 5; conservan la restricción a proyecto demo y emulador local.
- Widget: transmite utm y solo la presencia de los identificadores de clic, junto con el dominio validado del padre.

## Reproducción

Preparación y seeds en [el README del backend](../../../../functions/src/fase5/README.md). Las credenciales de demostración están en `/entrar`, con contraseña `Llenamos2026!`. No ejecutar las suites masivas en paralelo con el navegador.

```sh
# Con los emuladores y la web de la fila 2, cargados los cinco seeds:
pnpm exec tsx scripts/fase5-verificar.ts pnpm exec tsx scripts/fase5-navegador-integracion.ts

# Sin otra instancia de emuladores en esos puertos:
TEST_FIREBASE_EMULATORS=1 pnpm exec tsx scripts/fase5-verificar.ts \
  npx firebase emulators:exec --project demo-llenamos --config firebase.agente2.json \
  --only auth,firestore,storage \
  "pnpm --filter functions exec vitest run src/fase6-privacy src/fase6-backup src/fase5 --hookTimeout 60000"

pnpm exec tsx scripts/fase5-verificar.ts npx firebase emulators:exec \
  --project demo-llenamos --config firebase.agente2.json --only firestore,storage \
  "vitest run --root tests/rules"
```

Para las tandas con Functions: `TEST_FIREBASE_EMULATORS=1`, `FUNCTIONS_PORT=5013`, `FUNCTIONS_EMULATOR_HOST=127.0.0.1:5013`; también `TEST_R2_EMULATORS=1` para mensajes, espera y señal. El lanzador proporciona los hosts y la clave local de custodia. Billing usa `STRIPE_BILLING_WEBHOOK_SECRET=whsec_solo_fixtures_locales`; señal y WhatsApp, `STRIPE_WEBHOOK_SECRET=r2-local-test` y `WHATSAPP_APP_SECRET=r2-local-test`. Son secretos ficticios, sin claves de pago o envío.

Las decisiones comerciales y de producción siguen pendientes en la tabla del propietario de la fase 5 de `ARQUITECTURA.md`. No se han hecho commit, push ni despliegue.
