# Identidad e invitaciones: contrato de seguridad

Estado: implementado en la API VPS con PostgreSQL y Firebase **solo Auth**, además del
adaptador local de transición. Probado con PostgreSQL real y Auth emulado. Este documento no
certifica un despliegue ni el lanzamiento del resto del producto.

## Alta y consentimiento del titular

`invitarMiembro` rechaza el campo `password`. Crear o reutilizar una cuenta no modifica su
contraseña ni concede acceso: la membresía empieza con `active: false` e
`invitationPending: true`; el perfil no enumera el restaurante hasta aceptar. También se aplica
al propietario que da de alta LogiQD. Una cuenta puede aceptar varios restaurantes.

La invitación solo se entrega al buzón del destinatario mediante correo **de plataforma**.
Nunca se utiliza el proveedor configurado por el restaurante que invita: ese administrador
podría leer el enlace en su proveedor. Sin correo de plataforma real el estado es `pending`
y la membresía sigue inactiva. La respuesta al operador nunca contiene contraseñas, enlaces
ni tokens. Un fallo de correo no anuncia entrega.

El enlace lleva `#i=<id>&t=<token>` en el fragmento: el navegador no lo envía a servidores,
proxy ni cabeceras Referer. La pantalla lo lee al enviar el formulario y manda las credenciales
en el cuerpo de `aceptarInvitacion`, una operación pública que no depende del ID token de la
sesión anterior. No añadir analítica que lea el fragmento.

El token aleatorio de 256 bits caduca en 24 horas, se valida por hash SHA-256 y
se consume una sola vez. Solo el servidor conserva su versión cifrada para reintentar el
correo. No se incluye en mensajes operativos, exportaciones de restaurante ni respuestas.
Cancelar una invitación invalida el token y libera su capacidad reservada; reenviar después
genera otro. Aceptar revalida la membresía, su rol y los permisos de quien invita.

## Cambio de credenciales y sesiones

Poseer el enlace privado prueba control del correo. El destinatario consiente expresamente
cambiar la contraseña de **toda su cuenta**, verificar su correo y cerrar sus sesiones
anteriores. No se cambia una contraseña ajena durante el alta ni al enviar una invitación.

La aceptación bloquea primero la identidad en el almacén de autorización, con un lease por
cuenta para serializar aceptaciones. Después actualiza Auth, establece el claim
`sessionVersion` (32 caracteres hexadecimales aleatorios) y revoca los refresh tokens. Solo
entonces activa la membresía, publica el restaurante en el perfil, consume la invitación y
desbloquea la identidad. Un fallo intermedio deja la cuenta bloqueada; el titular puede
reintentar tras caducar el lease de dos minutos o recibir otra invitación. No hay bypass del
operador para activar sin prueba de buzón.

Revocar refresh tokens no basta: un ID token ya firmado puede seguir vigente. Las callables
autenticadas pasan por `identity-call`, que compara la generación actual y `auth_time` con
`tokensValidAfterTime`. Las reglas locales Firestore/Storage también comparan la generación y
el bloqueo, incluido el perfil propio. La interfaz cierra la sesión anterior antes de aceptar,
inicia sesión con la nueva contraseña y fuerza `getIdToken(true)`.

## PostgreSQL y runtime productivo

- Claim externo: `sessionVersion`, hex32. `auth_time` es Unix en **segundos**.
- Estado SQL: `session_version`, `tokens_valid_after` como fecha UTC, `locked`, `disabled`.
  Comparar `auth_time >= floor(tokens_valid_after_ms / 1000)` y la generación exacta.
- La API exige registro SQL de identidad antes de cualquier ruta autenticada. Firebase Auth
  por sí solo no concede membresía ni rol de plataforma. No insertar registros desbloqueados
  automáticamente al recibir un ID token desconocido.
- La migración `003_invitations.sql` implementa preparación, aceptación, cancelación y cambios
  de rol mediante procedimientos estrechos `SECURITY DEFINER`. El runtime no puede escribir
  directamente identidades/membresías ni leer la tabla privada de invitaciones. Los permisos
  internos de migración no se conceden al rol HTTP.
- La aceptación mantiene un advisory lock PostgreSQL por UID durante **toda** la secuencia
  Auth, entre las transacciones de bloqueo y activación. Caducar el lease no permite ejecutar
  otra operación Auth concurrente. El cierre comprueba lease, generación, membresía y permisos
  actuales del invitador; un fallo deja bloqueo e invitación recuperable por su titular.
- El preflight de `invitarMiembro` valida rol, restaurante y capacidad antes de crear cuentas
  Auth; la transacción vuelve a reservar el hueco. Los roles conservan el contrato original:
  solo propietarios gestionan propietarios o asignan owner/manager; un manager puede asignar
  roles inferiores y modificar a otro manager hacia un rol inferior.
- Reintentar un alta administrativa sólo renueva invitaciones de propietarios pendientes.
  No reactiva propietarios activos, dados de baja ni que hayan cambiado de rol. Sin clave de
  cifrado y correo la invitación sigue pendiente; configurarlos y reintentar el alta genera la
  credencial entregable. No hay entrega simulada ni proveedor de restaurante alternativo.
- El helper puro `currentIdentity` de core describe la comprobación del adaptador de
  transición. Su compatibilidad con usuarios **antiguos sin estado** no es el bootstrap
  productivo: la API nueva requiere siempre estado y su propia prueba explícita de identidad.
- No restaurar generaciones de sesión ni invitaciones desde copias de contenido. No guardar
  el cuerpo de aceptación, las contraseñas ni el fragmento en logs.

Configuración por archivos privados del runtime:

- `IDENTITY_ADMIN_CREDENTIAL_FILE`: cuenta de servicio del mismo proyecto Auth. El adaptador
  sólo importa `firebase-admin/app` y `firebase-admin/auth`; requiere leer, crear y actualizar
  usuarios Auth, sin permisos Firestore/Storage/Functions. No monta una credencial de migración.
- `PLATFORM_INVITATION_KEY_FILE`: 32 bytes hexadecimales para AES-256-GCM; el AAD vincula cada
  token al identificador de invitación. Conservar la clave para reintentos de envíos existentes.
- Correo opcional: `PLATFORM_EMAIL_ENABLED=1`, `PUBLIC_APP_URL` como origen HTTPS,
  `EMAIL_FROM` y `RESEND_API_KEY_FILE`. Sólo un id real de Resend marca envío confirmado;
  el estado se confirma de nuevo en SQL para evitar anunciar tokens cancelados o sustituidos.

Los envíos pendientes están almacenados de forma durable. Se reintentan al repetir la
invitación o el alta idempotente; todavía no hay un trabajador periódico para esta cola.
Sin la credencial de administración Auth no se registra la aceptación ni se permite un alta
ficticia; el readiness declara el backend incompleto.

Las altas antiguas con `platformProvisioning` sin `identityFlowVersion: 2` se detienen para
revisar la identidad. Cuentas y membresías históricas ajenas al nuevo flujo requieren una
migración revisada antes del lanzamiento. No se han modificado usuarios reales de Firebase.

## Evidencia de regresión

La integración con Auth y Firestore emulados reproduce una cuenta precreada por otro
restaurante con contraseña conocida: no accede al nuevo restaurante antes del consentimiento;
aceptar invalida la contraseña y el ID token antiguos, admite la sesión nueva y rechaza el
replay del enlace. Otra prueba cancela y reenvía invitaciones. Las suites de reglas comprueban
el rechazo de generaciones antiguas y cuentas bloqueadas en datos y archivos.

La suite `apps/api/src/invitations/service.integration.test.ts` añade siete escenarios con
PostgreSQL real y Auth emulado: cuenta precreada y aceptación HTTP pública, dos restaurantes,
contraseña e ID token antiguos, replay, cancelación/reenvío y cupo, fallo después de Auth con
reintento, concurrencia por UID con lease caducado, preflight sin efectos Auth, revocación del
invitador durante Auth y denegación de acceso general a tablas privadas. La entrega de correo
se intercepta sólo en pruebas; no se usa un proveedor real ni identidades de producción.

Para ejecutarla, usar una base PostgreSQL vacía y temporal cuyo nombre empiece por
`llenamos_api_test_invitation`, accesible sólo en loopback. Activar
`TEST_POSTGRES_INVITATIONS=1`, establecer `TEST_POSTGRES_URL` con esa conexión administrativa
temporal y arrancar únicamente el emulador Auth de `demo-llenamos` en loopback con una
configuración propia de puertos. Dentro de `firebase emulators:exec`, ejecutar
`pnpm --filter @llenamos/api exec vitest run src/invitations/service.integration.test.ts`.
La suite aplica `001`, `002` y `003`; no reutilizar una base ya migrada ni dar ese usuario al
proceso HTTP. Las pruebas se saltan sin este opt-in explícito: un CI verde sin ese entorno no
certifica la integración de invitaciones.
