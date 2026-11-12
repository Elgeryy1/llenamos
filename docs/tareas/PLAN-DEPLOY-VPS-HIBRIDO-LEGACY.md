# Plan de despliegue de Llenamos en el VPS

**ARCHIVADO el 2026-11-10:** sustituido por `PLAN-DEPLOY-VPS.md` con Firebase solo para Auth.
Este plan híbrido no debe ejecutarse ni usarse para solicitar facturación de Functions/Storage.

Fecha: 2026-11-10. Estado: plan preparado; no se ha desplegado ni contratado nada.
Base revisada: `origin/main`, commit `b25978069adc983d80893107e0f1fe447890317c`, con CI correcta.

## 1. Alcance

Primer destino: el restaurante de los panas, en el VPS existente de LogiQD.
Alcance corregido por el usuario: publicar todo Llenamos (fases 0 a 6) y la web de presentación,
no cerrar el trabajo con un despliegue parcial de reservas. Los módulos de cada restaurante se
habilitan según su plan, pero todos deben estar preparados y validados para producción.
El usuario ha aclarado que no se contratarán proveedores antes del alta: el formulario de cada
restaurante pedirá APIs opcionales de pagos, WhatsApp, correo, fiscalidad y Repite. Todas pueden
quedar vacías. Una integración ausente no impide crear el restaurante ni publicar la plataforma;
sus acciones dependientes permanecen sin configurar. Guardar credenciales no certifica un
adaptador ni permite emitir documentos fiscales de prueba como reales.
La web pública de reservas y el panel Next.js se alojarán en Docker en el VPS;
la presentación de `apps/landing` se servirá como archivos estáticos.
Firestore, Authentication, Storage y Cloud Functions seguirán en Firebase de producción.
No se ejecutarán emuladores ni se copiará el restaurante de demostración a producción.

Esta es una propuesta híbrida, siguiendo la última recomendación del hilo. No aloja la base de
datos en el VPS. Pasar también los datos y el backend a PostgreSQL es otro proyecto: habría que
reemplazar consultas del SDK, reglas, transacciones, tiempo real, Auth, Storage, disparadores,
callables y trabajos programados. No se incluye esa migración en este despliegue.

El usuario ha pedido ejecutar y terminar el plan. Se han iniciado los cambios y las verificaciones;
la configuración productiva necesita identificar primero cuenta de Firebase/facturación y
proveedores del restaurante. No asignar recursos o cargos a una cuenta personal por suposición,
ni usar proveedores simulados para declarar completado el lanzamiento.

## 2. Infraestructura comprobada

- Acceso: alias SSH `VPS` usando la configuración de `C:/Users/elgery/.ssh/config`.
- Máquina: 4 vCPU, aproximadamente 8 GB de RAM y 125 GB de disco.
- Última lectura: unos 4,7 GB de memoria disponible y 65 GB de disco libres. Es una fotografía,
  no capacidad garantizada en horas punta; la swap conserva aproximadamente 1 GB ocupado.
- Servicios existentes: LogiQD HQ con PostgreSQL, Repite, Umbrel, n8n y herramientas auxiliares.
- Ya existen túneles Cloudflare. Solo SSH aparece escuchando públicamente; las publicaciones
  web del host están en loopback. No alterar su configuración ni reiniciar servicios ajenos.
- Llenamos irá en un proyecto Compose propio en el Docker del host, fuera del Docker anidado de
  Umbrel y sin usar la base de datos de LogiQD HQ.

Presupuesto inicial propuesto, a validar con carga:

- Next.js: límite de 1,5 vCPU y 1536 MiB de RAM. Un proceso Node en modo producción.
- Proxy y servidor de archivos estáticos: 0,25 vCPU y 128 MiB.
- Conector de túnel dedicado, si no se reutiliza uno de forma aislada: 0,25 vCPU y 128 MiB.
- Total máximo normal propuesto: 2 vCPU y 1792 MiB; no es RAM reservada ni consumo esperado.
- Mantener al menos 1,5 GB de memoria disponible durante el servicio. Si se supera el
  presupuesto, medir y corregir antes de subir límites o contratar más capacidad.
- Construir las imágenes en GitHub Actions o PC Compute; nunca durante el servicio en el VPS.
  Limitar logs y cachés y conservar solo las imágenes necesarias para rollback.

## 3. Direcciones y entrada HTTPS

Propuesta de nombres, pendiente de comprobar DNS y aprobarlos:

- `llenamos.logiqd.me`: presentación comercial estática.
- `app-llenamos.logiqd.me`: reservas, panel, carta QR, pagos y recibos; nombre de un solo nivel
  para comprobar cobertura del certificado de la zona sin contratar certificados adicionales.
- Preproducción: un nombre separado, con proyecto Firebase y datos de prueba propios.

Mantener una única URL canónica para la aplicación. Configurar tanto
`NEXT_PUBLIC_SITE_URL` como `PUBLIC_APP_URL`, retornos de Stripe, enlaces de correo, widget,
CORS, orígenes y dominios autorizados de Auth con esa dirección. Buscar referencias al dominio
antiguo y revisar las rutas de descarga y privacidad antes de publicar.

Entrada prevista: Cloudflare Tunnel hacia un proxy dentro de la red Docker de Llenamos, y de
ahí a Next.js o a la landing estática. Preferir un túnel dedicado para aislar cambios. Revisar
la topología existente antes de elegir reutilización o uno nuevo. Sin publicar el puerto de
Next.js a Internet ni abrir 80/443 por defecto.

### Acceso desde la presentación y separación de funciones

En la web de presentación habrá un botón «Acceder» con tres entradas: «LogiQD», «Soy propietario»
y «Soy trabajador». Las entradas llevan al servicio de autenticación de la aplicación, conservando
la landing como web estática. Comparten identidad, recuperación de contraseña y cierre de sesión;
elegir una entrada nunca concede un rol. El servidor comprueba permisos y dirige a cada persona.

- LogiQD: panel de administración de plataforma. Crear el restaurante, designar e invitar a su
  propietario, elegir/cambiar plan y módulos, y configurar los ajustes técnicos/comerciales
  necesarios para prestar el servicio. Usar un registro administrativo separado con los campos
  mínimos, sin consultas a colecciones operativas. Confirmar el inventario exacto de campos de
  «configuración» antes de ampliar permisos: no incluye gestionar el restaurante por dentro.
- Propietario: panel de su restaurante, su configuración operativa, equipo y módulos contratados.
  Puede invitar trabajadores y asignar roles dentro de sus permisos. No se concede administración
  de plataforma por ser propietario. La selección de plan corresponde a LogiQD, no a un autoservicio.
- Trabajador: solo restaurantes a los que pertenece y tareas de su rol (encargado, camarero, cocina
  o barra), respetando permisos por local y módulo. Invitación individual, sin contraseñas compartidas.
- Invitaciones con caducidad y uso único, activación por el destinatario y recuperación de cuenta;
  LogiQD no conoce ni fija contraseñas reutilizables del personal. Proponer MFA para LogiQD.
- APIs por restaurante, con campos de secretos enmascarados y solo de escritura: nunca se
  rellenan con credenciales leídas del servidor. En cambios, vacío conserva lo existente y
  retirar un proveedor requiere una acción explícita. Cifrar y vincular las credenciales al
  restaurante; denegar lecturas directas y no reutilizar variables globales de proveedores como
  fallback. Solo devolver estados de configuración. Sin correo transaccional de plataforma,
  distinguir invitación pendiente de enviada, sin entregar un enlace privado al operador.

El alta pública `/alta` deja de crear restaurantes directamente: será solicitud comercial o alta
por invitación de LogiQD. Revisar también las funciones de alta, cambio de plan, excepciones,
portal de Billing y cualquier API, para que la restricción no dependa del enlace mostrado.

LogiQD no puede acceder a reservas, clientes, alergias, comandas, caja, ventas, campañas, fichajes,
inventario, documentos ni copias/exportaciones de contenido del restaurante. No tiene vista
«entrar como», impersonación ni acceso de soporte a su interior. El claim `logiqd` no supone
pertenencia al restaurante ni un bypass de reglas. Eliminar o restringir `abrirAccesoSoporte` y
revisar permisos de privacidad/copias y métricas que actualmente dependan de ese claim.

Las funciones que hacen operaciones de alta o mantenimiento usan identidades técnicas mínimas
y auditadas; no devuelven contenido a un operador de LogiQD. Separar los registros administrativos
de los datos privados y probar esta separación en la interfaz, callables, API, reglas e IAM.
El SDK Admin ignora reglas de Firestore: los controles también deben estar en cada función.
El operador con privilegios de infraestructura podría acceder a datos desde la consola: limitar
IAM y cuentas de servicio, impedir uso ordinario de credenciales elevadas y dejar auditado el
procedimiento excepcional de recuperación. No prometer invisibilidad criptográfica con este diseño.

No poner una autenticación de Cloudflare delante de reservas, QR, recibos, API o webhooks
públicos. El panel utiliza sus permisos de Firebase. Proteger el entorno de preproducción sin
impedir las pruebas de callbacks; usar solo cuentas y proveedores de prueba.
Aplicar límites de solicitudes y tamaño de cuerpos en el proxy sin romper streaming.
No almacenar en caché HTML privado, API, pagos, recibos ni service workers; cachear únicamente
assets versionados y contenido público identificado. Comprobar el widget embebido y sus cabeceras.

Cloudflare se operará con `cf` CLI, conforme al AGENTS.md, salvo que se incorpore una configuración
Wrangler aplicable. No introducir Workers ni cambiar túneles de otros productos por este plan.

## 4. Etapa A: cerrar los bloqueos del código

Antes de preparar el primer piloto con datos reales:

1. Trabajar desde el `main` actualizado de GitHub, sin sobrescribir cambios locales. Leer
   ARQUITECTURA, PLAN, decisiones vigentes y las guías locales de Next.js 16.4.
2. Inventariar todos los guardas `localOnly`, usos de `demo-llenamos`, transportes simulados y
   variables de emuladores en rutas de ejecución. Convertir cada restricción necesaria en una
   implementación productiva con pruebas; no eliminar guardas para aparentar funcionamiento.
3. Caja: `functions/src/fase3/context.ts` restringe el proveedor de prueba a emuladores; fiscal,
   algunos cobros y procesos lo invocan. Conectar el proveedor fiscal elegido y revisar las
   rutas de cobro antes de habilitar el módulo. Completarlo antes de dar por terminado el
   despliegue completo; los tickets de prueba nunca se usarán como facturas reales.
4. Copias y privacidad: `functions/src/fase6-privacy/infra.ts` y los procesos de copia/privacidad
   tienen guardas locales. Implementar custodia de producción, acceso privado y restauración;
   probar las operaciones contra un proyecto de preproducción. Mantener una barrera real de
   mantenimiento mientras la copia exija ausencia de escrituras.
5. Resolver los pendientes anotados en TRASPASO: listado de facturas restringidas por privacidad,
   expiración de `platformEvents`, consulta global de `versions` en Billing que alcanza recetas
   y actualización o sustitución del recorrido `scripts/fase3-e2e.mjs`.
6. Inventariar disparadores y trabajos: contrastar todas las funciones programadas de cada fase
   con `functions/src/index.ts`. Exportar y desplegar las que falten, con horarios, permisos y
   alertas: mensajes, recogidas, pagos, stock, campañas, Repite, análisis, Billing, webhooks,
   copias y privacidad. Los scripts locales no equivalen a trabajos productivos configurados.
7. Deshabilitar accesos rápidos de demo, fixtures, proveedores locales y funciones de prueba fuera
   de emuladores; probar que el backend también rechaza su uso, no solo ocultarlos en pantalla.
8. Implementar el acceso desde la landing y el modelo de administración descrito arriba. Revisar
   todos los privilegios actuales de LogiQD, incluidos soporte, copias, privacidad y creación de
   miembros. Alta idempotente de restaurante y propietario, auditoría de planes/módulos y
   revocación de accesos sin dejar un restaurante sin propietario.

Criterio de salida: inventario sin bloqueos desconocidos, todas las fases con implementación
productiva y separación de accesos probada. Los planes limitan módulos por restaurante; no se
usan para ocultar una integración pendiente y declarar el producto completo.

## 5. Etapa B: empaquetar y preparar despliegue reproducible

Entregables de implementación:

- Dockerfile multietapa para Next.js, Node 22 y pnpm fijados al proyecto; salida `standalone`
  con trazado correcto del monorepo y `@llenamos/core`. Copiar `public` y `.next/static`, usuario
  sin privilegios, `NODE_ENV=production`, apagado correcto y comprobación de salud.
- Construir la landing de Vite y servir `apps/landing/dist` sin servidor de desarrollo.
- Compose propio, por ejemplo `/srv/llenamos`, con redes, límites, reinicio automático,
  rotación de logs y volumen de caché si procede. No montar el socket Docker en la aplicación.
- Proxy con límites, streaming y rutas de salud que no revelen secretos. No usar `next dev`,
  Vite dev, seeds ni emuladores como servidores de producción.
- Configuración de ejemplo productiva sin credenciales; validación al arrancar de proyecto,
  dominio, servicios obligatorios y ausencia de variables de emuladores.
- CI que compruebe, compile y publique imágenes por SHA/digest en un registro privado.
  Despliegue por versión explícita, acceso de solo lectura al registro desde el VPS y registro
  del SHA web, funciones, reglas e índices que forman cada release. Evitar etiquetas `latest`.

Las variables `NEXT_PUBLIC_*` quedan incorporadas al compilar: producir la imagen con la
configuración del destino y no reutilizar una imagen de demo cambiando solo el entorno Docker.
No incorporar claves privadas, cuentas de servicio ni tokens a capas o argumentos de build.
La configuración pública del SDK Firebase no sustituye reglas de acceso ni es un secreto servidor.

## 6. Etapa C: Firebase y proveedores de producción

Tras aprobar recursos y costes:

1. Crear o seleccionar un proyecto Firebase real bajo titularidad de LogiQD o la acordada con
   el restaurante. Separarlo del proyecto de preproducción y de `demo-llenamos`.
2. Elegir ubicación europea de Firestore y Storage antes de crear datos; Functions en
   `europe-west1`, comprobando compatibilidad, latencia y disponibilidad de los servicios.
3. Activar la facturación necesaria, alertas de gasto, cuotas y límites de escalado. Las alertas
   de presupuesto no son un tope de factura. El VPS existente no elimina el coste de Firebase,
   correo, WhatsApp, Stripe ni almacenamiento externo de copias.
4. Configurar Auth, dominios autorizados, remitente y recuperación de contraseña. Crear al
   propietario real y sus roles mediante operaciones autorizadas; cargar solo datos validados
   del restaurante. Denegar acceso a las cuentas de demostración.
5. Desplegar reglas, índices, Storage y funciones con el proyecto indicado explícitamente en
   cada comando. Esperar a que índices y funciones estén listos antes de conmutar la web.
6. Custodiar claves del backend en Secret Manager y enlazarlas a cada función que las necesite;
   permisos mínimos por cuenta de servicio. Mantener permisos IAM separados del rol del panel.
7. Configurar proveedores por módulo: Stripe y firma de webhooks; correo y dominio remitente;
   WhatsApp Business y plantillas; push y VAPID; proveedor fiscal; API de Repite y autenticación.
   Primero prueba aislada, después producción, sin cobros ni campañas masivos de validación.
8. LogiQD asigna el plan y los módulos al dar de alta el restaurante. Adaptar Billing a ese
   circuito: el propietario puede ver sus condiciones/facturas, sin cambiarse permisos o plan
   por su cuenta. Definir cómo se cobra la cuota, manteniendo separados los cobros de clientes
   del restaurante y la suscripción de Llenamos. Comprobar que callbacks de Billing no pisan
   excepciones autorizadas ni permiten activar módulos sin la política de LogiQD.

La web seguirá conectándose directamente al SDK de Firebase y a sus funciones HTTPS; no se
ejecutará el backend de Cloud Functions dentro del contenedor Next.js.

## 7. Etapa D: copias, observabilidad y continuidad

- Copiar configuración, manifiestos y versiones del VPS a un destino externo cifrado. Una
  copia del VPS no contiene Firestore, Auth ni los archivos de Storage de Firebase.
- Definir copia y recuperación de Firestore/Storage y reconciliación de identidades de Auth.
  Usar protección gestionada cuando esté disponible y presupuestada, además del trabajador de
  restaurante una vez habilitado de verdad. Guardar claves de descifrado separadas de las copias.
- Propuesta inicial de continuidad para aprobación: copia diaria, retención 30 días, recuperación
  de hasta 24 h y restauración en 4 h. Medir esos objetivos; una copia diaria sola no asegura
  recuperar los cobros posteriores. Reconciliar diario, pagos y fiscal antes de reabrir caja.
- Primer simulacro obligatorio antes del piloto: restaurar en un destino aislado, verificar
  relaciones, identidades, supresiones de privacidad y archivos; mantener colas en cuarentena
  para no duplicar cobros, mensajes, impresión ni sellos.
- Alertas externas para caída web, errores de funciones, trabajos atrasados, copias fallidas,
  disco, memoria disponible, reinicios por OOM y actividad de swap. Medir el restaurante y también
  n8n, Repite y HQ durante las pruebas de carga. No bajar sus límites a ciegas.
- Registrar errores y latencias sin tokens de reserva, QR, destinatarios ni datos sensibles en
  logs. Probar redacción y política de retención.

## 8. Etapa E: aceptación en preproducción

Primero `pnpm verificar`, integración con disparadores y recorridos reales de las fases activas.
Después repetir contra Firebase de preproducción, sin emuladores, y la imagen Docker final:

- Reserva, cancelación, espera, duplicados y asignación con dos usuarios simultáneos.
- Permisos por rol, otro restaurante y módulo desactivado; acceso directo a API y Firestore.
- Tres entradas desde la landing: inicio/cierre de sesión, recuperación e invitaciones; el
  usuario no obtiene otro rol cambiando de enlace ni manipulando la redirección.
- LogiQD da de alta, invita al propietario y asigna/cambia el plan, pero recibe denegación al
  intentar leer o modificar cualquier dato interno, incluso por acceso directo, soporte, API,
  copias, exportaciones y rutas de Storage. Propietarios/trabajadores no administran otros locales.
- Carta, QR, comandas, cocina, barra y para llevar, con todos los módulos del producto probados.
- Pago de prueba, webhooks repetidos, caja y proveedor fiscal real en su entorno de pruebas.
- Correo, WhatsApp y avisos con dispositivos reales; impresora y cajón reales para caja.
- Pérdida y recuperación de conexión, reconexión del tiempo real y actualización del service
  worker sin repetir operaciones. Comprobar qué operaciones no funcionan sin conexión.
- Exportar y suprimir un cliente de prueba, y restaurar una copia con tombstones posteriores.
- Carga inicial propuesta: 10 dispositivos del personal, 30 clientes públicos simultáneos y
  ráfagas de reserva durante 30 minutos, con duplicados y contención incluidos. Ajustar a la
  ocupación real. No admitir reservas sobrevendidas ni operaciones económicas duplicadas.
- Medir latencia p95 y errores; objetivo provisional de respuestas interactivas por debajo de
  2 s, excluyendo proveedor de pago y tareas asíncronas, sin reinicios ni presión sostenida de RAM.
  Comparar con la línea base de los demás servicios para detectar degradación.

No dar por pasada esta etapa solo porque la CI esté en verde: la CI actual verifica el código,
pero no certifica el entorno productivo ni los proveedores reales.

## 9. Etapa F: publicación y vuelta atrás

1. Elegir ventana fuera de servicio; validar propietario, carta, mesas, horarios, impuestos,
   teléfonos y textos legales. Guardar copia previa y versiones de configuración y permisos.
2. Arrancar la imagen candidata en paralelo con capacidad comprobada. Durante la sustitución
   habrá dos procesos web brevemente; si no cabe, usar una ventana de mantenimiento acordada.
3. Comprobar salud, acceso, reserva y lectura de datos antes de cambiar la ruta del proxy/túnel.
4. Publicar la aplicación y después la landing; hacer una prueba controlada con el propietario.
   No redirigir otros productos de LogiQD como efecto colateral del despliegue.
5. Hacer el piloto en un servicio acordado, con procedimiento alternativo manual y seguimiento
   de errores, colas, consumo y avisos. No convertirlo en el único sistema del restaurante hasta
   superar el piloto y confirmar facturación e impresión para el alcance completo acordado.
6. Ante fallo: detener nuevas operaciones si hay riesgo, volver al digest anterior y conmutar
   el proxy. Conservar datos y registros. Rollback de la web no revierte Firebase: funciones y
   esquemas deben mantener compatibilidad con la versión anterior. No restaurar una copia
   antigua ni deshacer reglas sin reconciliar operaciones posteriores.

## 10. Orden de trabajo y decisiones necesarias

Orden: A (bloqueos), B (imagen/Compose), C (preproducción y proveedores), D (restauración),
E (aceptación), F (piloto). Preparar B puede avanzar mientras se resuelven decisiones de A.

Antes de crear recursos o publicar, confirmar:

- Aceptar expresamente el modelo VPS + Firebase y su coste variable; si se quiere todo en el
  VPS, sustituir este alcance por un plan de migración completo.
- Dominios definitivos y quién es titular de los datos y cuentas de proveedores.
- Alcance fijado: todo Llenamos y presentación con tres entradas; no volver a preguntar si se
  quiere un despliegue parcial. Falta concretar qué plan/módulos tendrá cada restaurante y los
  campos administrativos configurables por LogiQD sin acceso a su funcionamiento interno.
- Cuenta de cobros, proveedor fiscal, WhatsApp, correo y Repite según módulos habilitados.
- Datos legales, políticas de privacidad y retenciones, revisados por el responsable.
- Destino externo de copias, objetivos de recuperación, presupuesto y fecha de piloto.

Resultado esperado: despliegue reproducible y reversible en el VPS, con datos reales solo en
servicios productivos, capacidad medida y módulos habilitados únicamente cuando pasan sus pruebas.

## Referencias

- [Estado del producto](https://github.com/LogiQD/llenamos/blob/b25978069adc983d80893107e0f1fe447890317c/docs/ESTADO.md)
- [Traspaso y pendientes](https://github.com/LogiQD/llenamos/blob/b25978069adc983d80893107e0f1fe447890317c/docs/tareas/TRASPASO.md)
- [Next.js alojado en servidor propio](https://nextjs.org/docs/app/guides/self-hosting)
- [Docker para Next.js](https://docs.docker.com/guides/nextjs/)
- [Secretos de Cloud Functions](https://firebase.google.com/docs/functions/config-env)
- [Despliegue de Cloud Functions y facturación](https://firebase.google.com/docs/functions/get-started)
