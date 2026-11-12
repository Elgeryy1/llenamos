# Plataforma en PostgreSQL

Migrado: catálogo provisional versionado, alta administrativa, listado paginado, configuración
de plan/módulos y credenciales opcionales por restaurante. Se conservan los contratos de core;
los importes siguen siendo una propuesta provisional y no se ha activado ningún cobro.

`002_platform.sql` guarda suscripciones, contadores, recibos idempotentes, auditoría y custodia
de APIs. Un rol NOLOGIN sin BYPASSRLS posee únicamente funciones estrechas: puede crear el
restaurante/local, proyectar un plan y guardar ciphertext. El usuario HTTP no recibe ese rol
ni privilegios generales de escritura sobre restaurantes, identidades o membresías. FORCE RLS
permanece habilitado. La API llama a esos procedimientos dentro de `withIdentity`; todos
comprueban al actor de plataforma en SQL. La lectura administrativa no toca datos operativos.

El alta se serializa por actor/comando y reserva un propietario y un local. Solo `003_invitations`
crea la identidad bloqueada y la membresía pendiente; una cuenta ya activa en otro restaurante
mantiene su identidad, y la nueva membresía queda inactiva. El envío ocurre después del COMMIT,
sin devolver al operador contraseñas, tokens ni enlaces. Sin correo la respuesta dice `pending`.
Reintentar el comando original recupera el mismo restaurante y renueva la invitación pendiente
si caducó o no había custodia; nunca reactiva a un propietario ya dado de baja.

La configuración bloquea restaurante/suscripción/uso, comprueba revisión y límites y registra
el motivo. El recibo se vincula al actor, restaurante y comando. Una suscripción vinculada a
Stripe requiere revisar su contrato; la cancelación es final. `serviceUntil` debe ser futuro,
como máximo 366 días. Módulos y fechas se calculan en el servidor. RLS de datos operativos y
el guard de operaciones de miembros comprueban el vencimiento con cada petición, sin depender
de un worker. La lista/sesión pueden seguir mostrando metadata para explicar el problema;
el contexto del panel vencido responde con un error de plan.

APIs: AES-256-GCM, nonce aleatorio, clave derivada y contexto autenticado con el ID del
restaurante. Cada negocio tiene su propia fila cifrada. Vacío conserva, retirada explícita
elimina el proveedor incluso si era parcial. No se heredan claves globales de otros negocios.
Las respuestas incluyen estados, nunca valores secretos. `configured:true` indica credenciales
completas; `adapter_pending` recuerda que los consumidores VPS todavía no están migrados.

Variables de archivos secretos:

- `IDENTITY_ADMIN_CREDENTIAL_FILE`: cuenta de servicio del mismo proyecto, con permisos de Auth.
  Opcional para el arranque; sin ella no hay alta ni registro de handlers de invitación/equipo.
- `PLATFORM_INVITATION_KEY_FILE`: 64 caracteres hexadecimales, clave de 32 bytes. Sin ella se
  permiten altas pendientes sin token cifrado ni envío; necesita reintento cuando se configure.
- `PLATFORM_INTEGRATION_KEY_FILE`: mismo formato, clave separada para APIs. Sin ella funcionan
  campos vacíos; guardar credenciales o abrir las existentes falla cerrado.
- `PLATFORM_EMAIL_ENABLED=1`: exige las anteriores de identidad/invitación, `PUBLIC_APP_URL`
  (origen HTTPS sin rutas), `RESEND_API_KEY_FILE` y `EMAIL_FROM`. Sin habilitación explícita
  no se envía correo. Una configuración habilitada incompleta impide arrancar.

Los contadores de uso se reservan para el alta y las invitaciones; nuevos dominios deberán
mantener sus contadores y límites en la misma transacción. No están migrados reservas, sala,
caja, fiscalidad, proveedores de pago/mensajería, archivos, realtime, copias ni workers. El alta
no inventa mesas, carta o ajustes de esos dominios todavía no portados. Falta provisionar las
credenciales reales y el primer operador SQL mediante un procedimiento operativo separado.

Pruebas: `sh apps/api/scripts/test-postgres-docker.sh` incluye PostgreSQL real, dos restaurantes,
LogiQD, reintentos concurrentes, slugs, propietarios compartidos, revisión optimista, fechas,
límites, cifrado, retirada y negación RLS al vencer. La suite de invitación con Auth emulado
se ejecuta aparte mediante su script; el test de plataforma usa un adaptador Auth aislado.
