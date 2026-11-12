# Copias de seguridad y privacidad · qué cubre y qué no

Estado: verificado solo en local con los emuladores (`demo-llenamos`). Nada de esto es una promesa de cumplimiento legal ni un acuerdo de nivel de servicio. Los plazos y los objetivos son propuestas técnicas provisionales que el propietario debe validar con su asesor antes de vender.

## Copias de seguridad

Qué hace:

- Una copia coherente por restaurante: lectura en una sola transacción de solo lectura (todas las subcolecciones, los locales, la proyección pública, el slug, las membresías del restaurante en `users/{uid}` y los archivos de Storage del restaurante), comprobada una segunda vez para detectar cambios durante la captura.
- Se cifra con AES-256-GCM y la versión de clave `v1`, que se guarda fuera del archivo (variable `PLATFORM_DATA_KEY_V1`, 32 bytes en base64). Cada archivo lleva su huella SHA-256, su tamaño y su número de registros en el manifiesto.
- Copia diaria propuesta (`copiasProgramadas`, 03:00 de Madrid) y simulacro mensual propuesto (como máximo 30 días entre simulacros). En el emulador no corre solo: `pnpm tsx scripts/copias-local.ts [restaurante|todo]` ejecuta exactamente el mismo trabajador.
- Retención de las copias: 30 días (propuesta). Después se borran los archivos y el manifiesto queda como caducado.
- Credenciales fuera de la copia: secretos de webhook, suscripciones push y PIN de fichaje nunca entran. Tras restaurar hay que rotar los secretos de webhook, volver a registrar los avisos push de cada dispositivo y fijar de nuevo los PIN.

Simulacro de restauración de un restaurante:

1. Restaura en un prefijo aislado dentro de la base de demostración (`restoreSandbox/restore-…`), nunca sobre los datos vivos ni sobre otro restaurante.
2. Valida: huellas y tamaños de los archivos, aislamiento por restaurante, relaciones de servicio y caja (sesión, comanda, cuenta), cadena y totales fiscales (sin reconstruir cadenas ni asignar números), tombstones de privacidad y colas.
3. Aplica los tombstones vigentes posteriores a la copia antes de dar por válida la restauración, para no resucitar a una persona ya suprimida. Las exportaciones antiguas no se vuelven a publicar.
4. Las colas (mensajes, impresión, pagos, fiscal, webhooks) pasan a `restore_quarantine`: ningún emisor las reclama. No se envía, imprime ni cobra nada al restaurar y no se duplican colas ni mensajes. Las claves de API se revocan y los destinos de webhook quedan suspendidos.
5. Mide el RPO (de la copia al inicio del simulacro) y el RTO (de inicio a verificación terminada, no solo la lectura de archivos) y los compara con los objetivos provisionales (RPO 24 h, RTO 4 h).

Cómo repetirlo y la última evidencia: [`simulacro-local.json`](simulacro-local.json), generado con `pnpm tsx scripts/copias-demo.ts`.

Qué NO cubre:

- No es una restauración productiva. Esa es un procedimiento aparte, con revisión del propietario, y debe hacerse tras una barrera de mantenimiento.
- No restaura cuentas de Auth ni contraseñas. En un destino real hay que reconciliar los uid con Auth sin recrear cuentas de otro inquilino.
- Una copia anterior al último cobro no basta como verdad de caja: hace falta el diario posterior y una consulta al proveedor de pagos y al fiscal antes de abrir caja. Los efectos en cuarentena pasan a revisión humana o a reconciliación con el proveedor por el mismo identificador.
- Los tiempos medidos son de un restaurante pequeño de demostración en un emulador. No demuestran un RPO ni un RTO reales con datos de producción.
- El almacenamiento, la custodia de la clave y la copia inmutable externa del proveedor no están elegidos todavía.

## Privacidad (RGPD)

Qué hace:

- Consentimientos por propósito (`marketing_email`, `marketing_whatsapp`, `digital_receipt`) como eventos inmutables con versión de política, fecha de servidor y referencia a una evidencia humana de identidad vigente. Retirar un permiso cancela los mensajes de ese propósito que sigan en cola. `assertMarketingConsent` queda listo para que los productores de campañas lo llamen al encolar y al enviar (aún no hay campañas ni Repite conectados).
- Exportar los datos de un cliente: inventario por identificador de cliente y por enlaces exactos (reserva, sesión, recogida, cuenta, cola de impresión, pago móvil), más mensajes por destinatario. Se cifra en Storage privado, la descarga es con un ticket opaco de un solo uso y 15 minutos como máximo, y caduca a las 24 horas. No incluye tokens, hashes de enlaces ni secretos, ni datos de otra persona.
- Borrar o anonimizar: por páginas, con puntos de retoma y reintento idempotente. Elimina ficha, espera y mensajes elegibles; anonimiza reservas, sesiones, comandas, tareas, actividad y recibos de idempotencia sin romper la barrera contra duplicados; revoca enlaces; cancela avisos; deja un tombstone y una auditoría mínima sin repetir los datos borrados.
- Se conserva con acceso restringido, sin modificar: facturas y toda la cadena fiscal (registros, respuestas, series, cola fiscal) y el registro de jornada (fichajes, turnos, bloqueos). Las facturas de una persona suprimida pasan a un índice de lectura restringida para el encargado.
- Caducidad automática (propuesta técnica, no plazo legal): mensajes a los 90 días, exportaciones a las 24 horas, y contactos, notas y alergias de clientes con 365 días sin actividad (se encola un borrado normal que sigue las mismas reglas). Nunca purga fiscal, laboral, retenciones marcadas ni servicio vivo.

Qué NO cubre:

- No decide plazos legales ni bases jurídicas: la política de privacidad, el contrato de encargado, las transferencias a proveedores y los plazos de conservación fiscal y laboral requieren revisión del propietario y de su asesor. El plazo laboral del registro de jornada (4 años) es una hipótesis a confirmar.
- Una solicitud con servicio vivo (reserva abierta, comanda sin cerrar, cobro o impresión pendiente), con texto libre ambiguo o con una copia compartida con otra persona queda bloqueada y visible; no se completa a medias.
- No retira datos de proveedores externos (correo, WhatsApp, Stripe) ni de archivos ya descargados, copias de seguridad ya hechas (se purgan al caducar y los tombstones se aplican al restaurar), dispositivos o impresos.
- La verificación de identidad es una atestación humana registrada por el procedimiento interno; el sistema no verifica a la persona por sí mismo.
- No se busca texto libre por nombre: si una persona aparece solo en un texto libre sin relación demostrada, se bloquea para revisión en vez de borrar a ciegas.
- Tener las pantallas y los trabajos no equivale a cumplir el RGPD.
