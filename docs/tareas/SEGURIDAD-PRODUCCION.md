# Seguridad y migración VPS

Auditoría Fable 5.2 recibida el 2026-11-10, sobre `6b76a3d`, antes de las APIs opcionales por
restaurante. No certifica versiones posteriores ni el futuro servidor PostgreSQL. No se ha
publicado el sistema. El informe original está en el hilo de revisión entregado al propietario.

## Prioridades verificables

- A1: contraseñas elegidas por invitadores y reutilización insegura de identidades. Corrección
  implementada y probada en el adaptador local: invitación pendiente, prueba del destinatario
  y sesiones viejas denegadas. Pruebas con cuenta precreada, contraseña conocida, token antiguo,
  cancelación y reenvío. Falta el flujo de alta/aceptación en SQL; no se considera cerrado en
  producción. Contrato en `docs/seguridad/IDENTIDAD-E-INVITACIONES.md`.
- A2: lecturas completas del histórico. Los repositorios SQL nuevos necesitan consultas acotadas,
  índices y carga con histórico realista. No copiar el mismo patrón a JSONB o a una tabla documental.
- A3: abuso de reservas/avisos públicos. Antibots, límite por cliente verificado/restaurante y
  destinatario, validación antes del contexto y outbox; demostrar que no llenan aforo ni generan spam.
- A4: consumidores sin secretos enlazados. La entrega posterior a la auditoría añade custodia por
  restaurante y bindings en el origen. En VPS, secretos montados y cifrado con contexto; ninguna
  clave global usada como fallback y pruebas contra eventos cruzados entre restaurantes.
- M5: proxy. Corregidos IP confiable, límite por cliente, privacidad y logs sin enlaces privados.
  Probado en Docker por el encargado. Compose debe conservar la red dedicada con IP del túnel fija.
- M1/M6: privacidad, enlaces y copias. Paginación sin límite arbitrario de6000 documentos, tokens
  cifrados/caducables, sin URLs privadas en logs/copias/exportaciones; restauración consistente.
- M3: integración en CI. Incluir PostgreSQL/Auth/worker con sus configuraciones reales de prueba;
  distinguir pruebas omitidas, fallos de entorno y regresiones. Imagen publicada no equivale a CI verde.
  Añadida integración PostgreSQL/JWT/HTTP y proxy a CI y antes de construir imágenes; la integración
  de invitaciones Auth y los futuros workers aún necesitan su job propio.
- M2/M4: índices y despliegue Functions se retiran del destino productivo; no son trabajo de nube
  pendiente. Sus garantías sí deben existir en índices SQL y en el pipeline del servidor nuevo.
- M7: errores trazables sin payloads/PII/secretos; memoria, CPU, conexiones y concurrencia acotadas.

## Regresiones funcionales que deben conservar prueba al portar

Repite inaccesible por contradicción de permisos; enlaces relativos o a localhost; reintento de
mensajes sin configurar; plantillas WhatsApp fuera de ventana; propietario de varios restaurantes;
cursores firmados de API; vencimiento y reactivación de planes; devoluciones y señal/fiscal solo local.
Cada hallazgo debe contrastarse con el código posterior y cerrarse con reproducción/prueba.

F2/F3 en el origen: reservas, lista de espera, recogida y marketing usan ahora un origen explícito
validado. Producción exige HTTPS sin rutas/credenciales/query ni fallback a localhost o landing;
la demo emulada conserva localhost. El helper puro de core se puede reutilizar al portar los
dominios. Prueba de integración verifica enlace absoluto entregado y funcional, y rollback si
el origen es inseguro; no constituye aún paridad del módulo de reservas PostgreSQL.

## Criterio de publicación

Cerrar altos aplicables y probar autorización directamente contra API/SQL, dos restaurantes y
LogiQD, invitaciones maliciosas, tokens revocados, concurrencia, abuso y restauración. No convertir
un hallazgo confirmado del origen en garantía de que la migración ya lo ha resuelto. Las dependencias
de proveedor opcionales se muestran como pendientes y no ejecutan respuestas ficticias de éxito.
