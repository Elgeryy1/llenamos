# Integración del backend de fase 5

Las reglas y los índices ya están en `firebase/firestore.rules` y `firebase/firestore.indexes.json`. Ninguna colección nueva admite escrituras del SDK cliente. Las lecturas replican `FASE5_ACCESS`: puntos para owner, manager y waiter con loyalty; Repite con repite; campañas y análisis para owner y manager; promociones activas para waiter; locales comprobados en los documentos de local, canjes, campañas y recomendaciones. Tokens, customerUses, outbox, logs, eventos, resúmenes, requests y salud son privados. Los índices simples de status los proporciona Firestore; los compuestos de cliente y fecha, cuenta y estado, campañas, orígenes, reintentos y recomendaciones están declarados.

El coordinador añade exactamente este bloque en `functions/src/index.ts`:

```ts
export {
  guardarConfiguracionFidelizacion, guardarPremio, altaFidelizacion, verCuentaFidelizacion,
  canjearPuntos, anularCanje, ajustarPuntos, guardarPromocion, cambiarEstadoPromocion,
  promocionesAplicables, aplicarPromocion, quitarPromocion, vincularRepite, guardarAjustesRepite,
  crearTarjetaRepite, verTarjetaRepite, darSelloRepite, avisarTeEchamosDeMenos, informeRepite,
  guardarConfiguracionMarketing, guardarSegmento, borrarSegmento, previsualizarSegmento,
  guardarCampana, simularCampana, lanzarCampana, cancelarCampana, informeCampana,
  darseDeBaja, informeOrigen, panelAnalisis, exportarAnalisis, guardarConfiguracionAnalisis,
  previsionOcupacion, verResumenDiario, guardarAutomatizacion, borrarAutomatizacion,
  simularAutomatizacion, resolverRecomendacion,
  acumularPuntos, revertirPuntosPorDevolucion, caducarPuntos,
  selloRepitePorReserva, selloRepitePorCobro, repiteOperacionCreada, procesarRepite,
  procesarCampanas, cancelarMarketingSinPermiso, agregarDiaAnalisis, enviarResumenDiario,
  eventoAnalisisReserva, eventoAnalisisStock, evaluarAutomatizaciones, caducarRecomendaciones,
  repiteLocal,
} from './fase5'
```

`repiteLocal` devuelve 404 fuera de demo y emuladores. Los procesos programados no se ejecutan automáticamente en el emulador. `fase5Requests` se conserva para la idempotencia; no hay TTL silencioso.

## Enganches integrados (2026-11-10)

1. `reservation-integration.ts` escribe origen y permisos de la reserva pública en la transacción de los creadores, incluidos personal, importación y lista de espera.
2. `messages/process.ts` comprueba `assertMarketingConsent` antes de enviar y cancela si falta. `webhooks/whatsapp.ts` reconoce `UNSUBSCRIBE_WORDS` mediante `isUnsubscribeReply`, registra la retirada una vez y cancela WhatsApp pendiente.
3. El inventario y trabajador de `fase6-privacy` cierran puntos, anonimizan movimientos y respuestas personales, eliminan destinatarios, logs, tokens y enlace Repite. La operación `remove_card` conserva `cardId` y `merchantId`, también tras fallos reintentables.
4. Navegación, ficha, caja, página pública y widget conectados. Evidencia de producto en [fase5](../../../docs/diseno/capturas/fase5/README.md).

Los enganches de puntos, devolución y sello ya están implementados con disparadores; no hacen falta cambios en los escritores de reservas o caja para ellos. No registrar dos versiones de esos disparadores al fusionar.
