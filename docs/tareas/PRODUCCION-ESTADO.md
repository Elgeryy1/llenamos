# Producción: entrega y bloqueos reales

Actualizado el 2026-11-10. Rama `deploy/vps-production`. **No publicado en producción.**

## Destino vigente

Todo en el VPS salvo usuarios y login en Firebase Auth: PostgreSQL, API Node, worker, archivos
privados, tiempo real, copias y webhooks. El plan híbrido anterior está sustituido. No activar
Blaze ni pedir facturación para desplegar Functions/Storage. Plan en `PLAN-DEPLOY-VPS.md`.

Proyecto Auth: `llenamos-logiqd`, cuenta `logiqd026@gmail.com`, número `844781008037`, aplicación
web `1:844781008037:web:74dee224fcac157c51894c`. Authentication aún no está inicializado y no hay
usuarios reales. Firestore se creó antes del cambio de arquitectura; está sin datos reales y
no será una segunda base productiva. No se borra automáticamente. El alias por defecto sigue
siendo `demo-llenamos`; cualquier operación real exige proyecto y cuenta explícitos.

## Implementado y comprobado

- Presentación con acceso para LogiQD, propietario y trabajador, login y recuperación con Auth.
  Elegir la entrada no concede permisos. LogiQD solo administra altas/planes/configuración,
  sin entrar al restaurante ni impersonar a su personal.
- `apps/api`: verificación JWT firmada con emisor/audiencia/proyecto, sesiones revocables en SQL,
  roles/membresías SQL, transacciones con contexto limitado y RLS. Runtime sin superusuario,
  BYPASSRLS ni propiedad de tablas. Sesión, contexto del panel y listado administrativo paginado
  funcionan contra PostgreSQL; el resto devuelve error hasta estar implementado.
- Frontend con transporte same-origin, Bearer en cabecera, validación de contratos y cancelación
  al salir/cambiar de cuenta. Sesión/contexto VPS sin listeners Firestore. Los adaptadores sin
  migrar fallan cerrados; no hay fallback productivo al backend Firebase.
- A1 del informe Fable corregido en el adaptador local: el invitador no elige contraseña,
  membresía inactiva hasta aceptación privada, token de un uso y sesiones antiguas denegadas.
  Falta portar el flujo completo a SQL. Contrato en `../seguridad/IDENTIDAD-E-INVITACIONES.md`.
- APIs de proveedores opcionales por restaurante implementadas en el origen, cifradas y sin
  heredar claves de otro negocio. Vacío conserva; retirada explícita elimina. Fiscal/Repite
  muestran adaptador pendiente. Sin correo de plataforma no se anuncia invitación enviada.
  Falta trasladar estos repositorios y consumidores a PostgreSQL.
- Docker/Compose preparados para web, proxy, PostgreSQL y API. DB sin puerto público, credencial
  runtime separada de migración. Proxy confía solo en el túnel fijo, no registra tokens/rutas
  privadas y distribuye el límite por IP real. Ruta `/api` verificada hacia el servidor nuevo.
- Pruebas de la entrega de los agentes: 23/23 JWT/SQL/HTTP, imagen API no root y migración repetible;
  77 pruebas frontend; invitaciones con 6 integraciones, 154 unitarias y 160 pruebas de reglas.
  PostgreSQL temporal y proxy probados en PC Compute; contenedores de pruebas retirados.
  CI añade integración SQL/proxy y construcción de imagen API. No confundir pruebas omitidas
  sin emuladores/SQL con integraciones ejecutadas.

## Pendiente antes de publicar todo Llenamos

1. Inicializar Auth clásico y configurar dominios, equipo LogiQD, custodia mínima y revocación;
   no se necesita facturación para un backend Firebase que ya no vamos a usar.
2. Alta/configuración, planes, miembros, roles, APIs opcionales e invitaciones/aceptación SQL;
   registro administrativo separado y bootstrap seguro de identidades.
3. Migración completa de reservas, sala/cocina/carta/recogida, caja/fiscal/impresión, personal,
   inventario/compras, marketing/análisis y plataforma. Cada dominio exige repositorio, permiso,
   transacción, eventos, UI y recorrido probado; la base de la API no equivale a esa migración.
4. Worker/outbox durables, realtime autorizado, offline, archivos privados y copias cifradas
   externas. Probar restauración aislada y reconciliar identidades, revocaciones y colas.
5. Cerrar hallazgos aplicables de Fable: abuso público, lecturas acotadas con histórico, tokens,
   privacidad/copias, enlaces/reintentos y regresiones. Ver `SEGURIDAD-PRODUCCION.md`.
6. Fiscal real: la caja del origen conserva proveedor de prueba, no válido para emitir facturas
   reales. APIs opcionales permiten crear el restaurante; el proveedor ausente queda desactivado,
   sin fingir cobros, avisos ni cumplimiento fiscal.
7. CI con Auth/worker, carga y paridad; límites de memoria medidos junto a n8n/Repite/HQ,
   IAM mínimo, datos legales, imágenes por digest, DNS/túnel/HTTPS y aceptación del piloto.

No se han tocado DNS ni servicios existentes del VPS ni activado facturación. El script de
release continúa bloqueado hasta la migración y aceptación; no publica una versión parcial
como producto terminado.
