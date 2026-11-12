# Todo Llenamos en el VPS salvo usuarios y login

Decisión vigente del propietario, 2026-11-10. Sustituye el plan híbrido archivado en
`PLAN-DEPLOY-VPS-HIBRIDO-LEGACY.md`. Estado: migración pendiente; no desplegado.

## Destino y alcance

- Firebase Authentication: cuentas, contraseña elegida por el titular, login y recuperación.
  Proyecto ya creado `llenamos-logiqd`, bajo `logiqd026@gmail.com`.
- VPS: presentación, Next.js, API, PostgreSQL, archivos privados, worker, webhooks, tiempo real,
  auditoría y copias cifradas a destino externo. No usar Firestore/Functions/Storage en producción.
- Proveedores opcionales por restaurante, con claves cifradas sin lectura de cliente ni fallback
  entre negocios. Vacío permite alta; el servicio dependiente queda sin configurar. Guardar una
  API fiscal/Repite no acredita un adaptador operativo.

No activar Blaze para el plan abandonado. Auth sigue siendo una dependencia externa y no se
promete que cualquier modalidad de login sea gratuita. No borrar Firestore ya creado por defecto;
está sin datos reales y no será base productiva secundaria. No importar Taberna Lumbre.

## Inventario confirmado y fronteras

37 archivos frontend productivos y 95 backend dependen de datos/funciones/archivos Firebase.
Contando pruebas son 49 y 117. El servidor exporta 237 símbolos entre handlers/triggers/jobs;
core registra 179 contratos tipados, además de cuatro wrappers heredados de fase 0. No son todos
endpoints públicos. Mantener lógica pura y esquemas de `@llenamos/core`.

- Separar `lib/firebase/client.ts` en cliente solo Auth y transporte local de datos.
- Cambiar `lib/data/{callables,functions}.ts`, `lib/publica/callables.ts` y `lib/carta/callables.ts`
  por API VPS validada con Zod. El UID/rol no se toma de un parámetro del navegador.
- Cambiar `lib/firebase/live.ts` por suscripción autorizada con cursor y reconexión, conservando
  `Live<T>`. SSE autenticado por fetch o WebSocket; nunca tokens en query.
- Eliminar escrituras directas de plano, ajustes, clientes y servicio mediante comandos explícitos.
- Reemplazar Storage por subida/descarga autorizada, límites y volumen fuera de la raíz pública.
- Sustituir transacciones/contextos que leen todo el histórico por repositorios acotados e índices.
- Portar outbox/disparadores dentro de la misma transacción SQL; jobs con leases e idempotencia.
- Preservar cola IndexedDB/Web Locks y portar streams, versiones, recibos y reconciliación.

## 0. Seguridad y contrato

Cerrar A1 confirmado por la auditoría Fable: el invitador no elige contraseñas y una coincidencia
de correo no concede propiedad/membresía sin demostrar identidad. Invitación pendiente y aceptación
del titular. Revocar sesiones efectivamente: no basta refreshTokens si se acepta un ID token viejo.
Aplicar comprobación también a endpoints y reglas del origen mientras se conserva para pruebas.

Clasificar el resto del informe sobre `6b76a3d` frente al código posterior: abuso público, consultas
ilimitadas, secretos, proxy, enlaces, privacidad, copias y regresiones. No atribuir al código nuevo
fallos ya corregidos ni considerar una compilación como aceptación productiva.

Definir contratos HTTP/error/paginación/transacción/evento y datos SQL por módulo, con pruebas de
paridad origen/destino. Roles/membresías/módulos en PostgreSQL; LogiQD solo administración mínima,
sin interior del restaurante, impersonación ni copias legibles.

## 1. API y PostgreSQL

API Node/TypeScript y worker separados. Verificar firma, emisor, audiencia, caducidad y revocación
de tokens Firebase. No aceptar custom tokens ni proyectos ajenos. Identidades administrativas de
Auth con permisos mínimos donde se necesiten, sin conceder acceso de datos por conservar login.

PostgreSQL dedicado: migraciones versionadas; rol de migración separado de ejecución, que no será
superusuario ni BYPASSRLS. Tablas operativas con restaurante/local, restricciones e índices.
Contexto actor/restaurante limitado a cada transacción del pool y consultas parametrizadas.
Pruebas SQL/API de aislamiento por restaurante, rol, local y LogiQD. No usar la DB de HQ.
`compose.postgres.yaml` prepara infraestructura, no significa que el producto ya la utilice.

## 2. Plataforma y recorrido inicial

Migrar alta/invitación, miembros, roles, planes, configuración de APIs y auditoría. Primer recorrido:
login Firebase -> API VPS -> permiso SQL -> alta/configuración -> lectura desde API en el panel.
No dejar perfiles operativos en `users/{uid}.restaurants` de Firestore ni solo portar las callables.

## 3. Reservas

Portar configuración, plano, disponibilidad, clientes, reservas, espera, importación y widget.
Concurrencia sin sobreventa, tokens privados, consultas por estado/fecha y actualización entre
dispositivos. Antibots y límites por IP verificada/restaurante/destinatario antes de encolar avisos;
validar credenciales antes de cargar contexto. Probar duplicados, token falso y abuso con carga.

## 4. Todas las fases restantes

Portar en tandas completas: carta/fotos/QR/comandas/cocina/barra/recogida; caja/fiscal/cobros/impresión;
personal/inventario/costes/compras; fidelización/campañas/análisis; plataforma/API/privacidad/copias.
Cada tanda incluye datos, endpoint, transacción, evento, UI y prueba de contrato/recorrido.

Outbox en la misma transacción que el hecho, reclamación segura entre workers, lease, reintentos
limitados e ID estable del proveedor. No doble cobro, envío, sello, impresión ni descuento de stock.
APIs opcionales: pruebas negativas sin configurar; nunca respuestas simuladas como éxito real.

## 5. Infraestructura y continuidad

Compose propio del Docker host, separado de Umbrel/HQ: web, API, worker, DB, gateway y túnel.
Compilar fuera del VPS; imágenes por digest, logs limitados, secretos montados con permisos
restrictivos, volúmenes DB/archivos y clave de custodia separada de copias. Sin socket Docker.
PostgreSQL sin publicar puertos, en red interna; solo API/worker autorizados la alcanzan.

VPS comprobado: 4 vCPU, 8 GB RAM, unos 65 GB libres. Presupuesto inicial sujeto a carga: web 256 MiB,
API 192 MiB, DB 384 MiB, worker 128 MiB, gateway 64 MiB y túnel 64 MiB (1088 MiB, antes 2816; propuesta de la migración W5 pendiente de validar con el ensayo con carga, sin decisión registrada del propietario). No es consumo medido ni
RAM garantizada. Mantener margen de al menos1,5GB disponibles y vigilar también n8n/Repite/HQ.

Dominios propuestos: `llenamos.logiqd.me` (presentación), `app-llenamos.logiqd.me` (aplicación).
HTTPS por túnel; IP solo del conector confiable; logs sin tokens/query/referer/rutas privadas;
privacidad en enlaces y excepción de frame solo para widget. No cachear datos privados.

Copias SQL/archivos cifradas fuera del VPS, retención y objetivos acordados. Restauración aislada
antes de lanzar, reconciliando UID Auth, revocaciones, movimientos posteriores y colas en
cuarentena. Snapshot del VPS no es copia externa ni prueba de restauración.

## 6. Aceptación y publicación

CI con integración PostgreSQL/Auth emulado/worker real y contratos, no solo reglas Firestore.
Carga con histórico representativo; concurrencia, aislamiento, offline, subidas, secretos,
pagos/webhooks duplicados, límites de abuso y restauración. Revisar hallazgos de la auditoría.

Publicar todo el producto cuando cada fase tenga paridad y no queden imports productivos de
`firebase/firestore`, `firebase/functions`, `firebase/storage` ni tráfico de datos a esos servicios.
El login sí mantiene Firebase Auth. Mantener legacy como referencia local, sin doble escritura real.
Release en ventana acordada con rollback de código y esquema compatible; no restaurar datos viejos
para deshacer código sin reconciliar operaciones. Piloto controlado antes de depender del sistema.
