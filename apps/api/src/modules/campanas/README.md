# Campañas, baja pública y origen de reservas (V7)

Segmentos, campañas con permiso, baja pública y origen de las reservas. Migraciones `011c_campanas.sql` y `016_clientes_revision.sql`.

## Flujo

1. `lanzarCampana` congela la regla del segmento y deja un trabajo `marketing.procesar_campana` (ID estable por campaña).
2. El worker lo atiende (`envio.ts`, `processCampaignHandler`): `processCampaigns` prepara páginas de 200 destinatarios con cursor y tope de
   50 000 clientes; por cada uno escribe su fila, el registro de frecuencia y un `marketing.campaign_message` en el outbox (UUID determinista).
   Fuera de la ventana de envío, reprograma otro trabajo a la hora permitida (no gasta intentos).
3. `marketing.campaign_message` (`campaignMessageHandler`): vuelve a comprobar permiso, supresión y ventana (`resolveCampaignMessage`), crea el
   enlace de baja **al enviar** (`issueUnsubscribeUrl`, solo queda su hash) y delega en el manejador común de avisos (`messageHandler`), que
   respeta las bajas, registra la entrega y, sin proveedor, falla con `not-configured` (recipient `not_configured`, nada simulado).
4. `marketingConsent` (en el `ModuleDefinition`) es lo que usa el worker para dejar salir marketing: sin permiso vigente, no sale.

## Baja pública (`darseDeBaja`)

`marketing_unsubscribe` (SECURITY DEFINER) comprueba **primero el token por hash**: una baja legítima nunca gasta el contador del slug. Solo los
fallos cuentan contra el slug (o contra el contador común de slugs inexistentes) y cada IP verificada (`src/client-ip.ts`, agrupada por /64)
tiene su límite. Misma respuesta exista o no el slug o el token; solo `limited` se traduce en 429. **El enlace no caduca**: `expires_at` es la
fecha de poda (2 años; los usados, 90 días tras la baja). Deja el evento `marketing.unsubscribed` como rastro de auditoría.

## Permisos de base de datos (016)

`customer_marketing` y `marketing_consents` ya no tienen custodia total (la ficha solo se toca en el restaurante de la transacción; el libro de
permisos solo admite INSERT, y la lectura limitada al restaurante de la transacción). Las tablas de campañas, destinatarios, tokens y contadores
de baja, que en 011c tenían `USING(true)` para el propietario de las funciones, ahora solo ven el restaurante fijado en `app.restaurant_id`
(la baja pública lo fija tras resolver el slug; `marketing_cancel_pending` lo fija y lo restaura). El contador de un slug es solo el de su
restaurante y la poda de ventanas viejas solo ve las anteriores al límite que fija la propia función. `location_exists` exige ser miembro del
restaurante. `marketing_cancel_campaign` exige propietario o encargado. `marketing_prune`, `marketing_erase_customer`, `marketing_rekey` y
`loyalty_anonymize` solo las ejecuta el worker, con el restaurante fijado en la transacción.
Las políticas `USING(true)` sobre `locations` de 007 (`reservas_location_custody`), 008 (`sala_custody`) y 012 (`billing_custody_locations`)
no son de este módulo: las deja anotadas aquí para que las revise su dueño.

## Reservas (sin tocar el módulo de reservas)

Disparadores de 016 (fijan `app.restaurant_id` a la fila que espejan y lo restauran, así funcionan con cualquier contexto: reserva pública, alta pública de sala, importaciones): `customers` → `customer_marketing` (una ficha suprimida no se vuelve a rellenar), `consents` → `marketing_consents`
(hora del servidor), `reservation_origins.data` → columnas del informe, y el cambio de estado de una reserva actualiza su origen y deja un
trabajo `clientes.reserva_cambiada` (sello de Repite y eventos de automatización). `recordReservationOrigin`, `recordReservationConsents` y
`updateOriginOutcome` siguen exportados para quien prefiera llamarlos (V11); son idempotentes y compatibles con los disparadores.

## Relleno de datos anteriores

`016` rellena `customer_marketing` y `marketing_consents` desde `customers` y `consents` de reservas (`INSERT … ON CONFLICT DO NOTHING`, idempotente; el bloque está entre `BACKFILL-INICIO` y `BACKFILL-FIN` y se prueba). El gasto (`spentCents`) se copia de la ficha de reservas, donde lo suma V11; una actualización de la ficha sin ese campo no lo pone a 0. Los enlaces de baja sin usar solo se podan si la persona ya no es cliente.

## Privacidad

`personalData` + `PrivacyContributor` (`privacidad.ts`): exporta ficha, permisos y envíos; borra anonimizando la ficha, añadiendo una baja de todo
en el libro de permisos, cancelando lo pendiente y retirando tokens, hash de contacto y registro de frecuencia. Los destinatarios en cola se cancelan por cliente y mensaje (no por payload, que el contribuyente común de avisos ya ha vaciado) y la ficha vuelve a cero (visitas, no presentados, última visita, gasto, idioma). Bloquea mientras haya un mensaje
reclamado por el worker. Al final del borrado, el `finalize` de `fidelizacion` cambia el id del cliente por uno aleatorio en todas las tablas de V7 y en los ids derivados (`marketing_rekey`).

## Pendiente o decisión de otros

- **Revisión legal**: «Te echamos de menos» (Repite, `avisarTeEchamosDeMenos`) se envía sin un permiso previo propio (solo respeta bajas).
- Ventas por origen (`updateOriginOutcome` con `salesCents`): caja no conoce la reserva de la cuenta; necesita el enlace sesión → reserva de sala.
