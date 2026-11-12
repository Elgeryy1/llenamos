# Llenamos by LogiQD · plan de construcción

Sistema completo para restaurantes (reservas, sala, cocina, caja, carta, clientes, personal y análisis). Se inspira en lo que hace RestaurantOS (repo privado `LogiQD/logiqd-restaurant-os`), pero **se escribe desde cero, sin copiar su código**. Se leen sus funciones y sus lecciones; el código es nuevo.

Fecha del plan: 2026-11-09. La web de venta está en `apps/landing` (`pnpm landing`).

---

## 1. Qué tiene que ser Llenamos

- **La promesa**: «llenamos tu sala». Lo que lo distingue de un TPV cualquiera son las **reservas que de verdad llenan mesas**: señal contra los no presentados, WhatsApp, lista de espera que avisa sola y reseñas.
- **Principio heredado de RestaurantOS** (buena idea, se mantiene): digital cuando ayuda, humano siempre disponible. La carta en papel, el camarero tomando nota y el efectivo siguen funcionando igual.
- **Se vende por partes**: un restaurante puede empezar solo con reservas y luego activar sala, cocina y caja sin cambiar de programa.
- **Planes y módulos**: cuanto más alto el plan, más módulos incluye. Además, LogiQD puede encender o apagar cualquier módulo en un restaurante concreto, aparte de su plan (pruebas, pilotos, regalos). El restaurante ve qué tiene, pero no puede activarse nada por su cuenta.
- **Repite dentro de Llenamos**: la tarjeta de sellos de LogiQD en Google Wallet ([LogiQD/repite](https://github.com/LogiQD/repite), logiqd.me/repite) entra como **módulo opcional**, apagado por defecto. Con él, sentar una reserva puede dar el sello solo y la ficha del cliente enseña su tarjeta.

## 2. Lecciones de RestaurantOS que se aplican (ideas, no código)

- Dinero siempre en céntimos enteros, nunca decimales.
- Los precios se recalculan en el servidor; lo que manda el móvil del cliente no se cree.
- Cada restaurante solo ve lo suyo, comprobado en el código y otra vez en la base de datos (RLS).
- Los avisos se anuncian desde la misma operación que los provoca (patrón «outbox»), para no avisar de cosas que no han pasado.
- Una tarea tiene dueño: dos camareros no pueden coger el mismo plato.
- Los avisos al móvil solo vibran cuando algo se está cayendo; si no, la gente los silencia.
- Nada se simula: si falta Stripe o el correo, se dice claramente.
- Lo que no hace el producto se escribe, para no prometerlo.

## 3. Pila técnica (decidida el 2026-11-09)

Todo en local con los **emuladores de Firebase**, preparado para subir a Firebase cuando toque. Detalle y contrato en `ARQUITECTURA.md`.

| Pieza | Elección |
|---|---|
| Aplicación | Next.js 16.4 + React 19 + TypeScript estricto, Tailwind 4 |
| Base de datos | Cloud Firestore (tiempo real y funcionamiento sin conexión de serie) |
| Acceso | Firebase Authentication |
| Servidor | Cloud Functions for Firebase (región europe-west1) |
| Archivos | Cloud Storage for Firebase |
| Pagos | Stripe (más adelante) |
| WhatsApp | API oficial de WhatsApp Business (más adelante) |
| Tickets legales | Verifactu con proveedor homologado (fase 3) |
| Pruebas | Vitest, pruebas de reglas contra el emulador, Playwright |

## 4. Fases

Cada fase termina con algo que se puede enseñar y vender. No se pasa a la siguiente sin pruebas en verde.

### Fase 0 · Cimientos (1–2 semanas)
- Repositorio, pila, CI con lint, tipos, pruebas y build.
- Modelo multi-restaurante: organización → restaurante → local → zona → mesa.
- Acceso del personal, roles (propietario, encargado, camarero, cocina, barra) y RLS en todas las tablas.
- Sistema de diseño con el aspecto de la web de venta.
- Registro de actividad que no se puede borrar.

### Fase 1 · Llenamos Reservas (el producto con el que se sale a vender) (4–6 semanas)
- **Interruptores de módulos**: cada restaurante tiene un plan y una lista de módulos activos (`reservas`, `sala`, `cocina`, `caja`, `repite`…). Solo los escriben las funciones y LogiQD; la interfaz, las funciones y las reglas comprueban que el módulo esté activo, igual que con los roles. El cobro de los planes llega en la fase 6.
- Editor de plano de sala: arrastrar mesas, zonas, mesas que se pueden unir.
- Horarios, turnos, duración por tamaño de grupo y disponibilidad.
- Página de reservas con la marca del restaurante + widget para su web + enlace para Instagram y Google Maps.
- Panel de reservas del día y plano en directo.
- Correo y **WhatsApp**: confirmación, recordatorio el día antes, confirmar o cancelar respondiendo.
- **Señal o garantía con tarjeta** al reservar (Stripe) y política de cancelación.
- **Lista de espera que avisa sola** cuando se libera una mesa.
- Asignación automática de mesa (sugerida, la decide el encargado).
- Ficha de cliente básica: visitas, no presentados, notas y alergias.
- Importar reservas desde Excel.
- **Petición de reseña en Google** al día siguiente.

### Fase 2 · Sala y cocina (4–6 semanas)
- Carta digital: categorías, platos, variantes, extras, alérgenos, fotos, agotados, menú del día, castellano, catalán e inglés.
- Comandero del camarero en móvil o tablet.
- Pedido desde la mesa por QR o NFC, llamar al camarero y pedir la cuenta.
- Pantallas de cocina y barra por estación, con tiempos y pases (primeros, segundos, postres).
- Tareas de sala con dueño («voy yo») y avisos al móvil solo cuando algo se retrasa.
- Mover y juntar mesas. Sentar una reserva abre la mesa y une el gasto al cliente.
- Para llevar con hora de recogida.

### Fase 3 · Caja y tickets legales (4–6 semanas)
- Cobro en efectivo y tarjeta, pagos parciales, dividir la cuenta, invitaciones y anulaciones con motivo.
- Apertura y cierre de caja con arqueo.
- **Tickets y facturas con Verifactu** (y TicketBAI). Factura simplificada y completa.
- Impresión de comandas y tickets en impresora térmica, cajón portamonedas.
- Pago desde el móvil del cliente (Stripe) y recibo digital.
- Propinas y reparto por horas trabajadas.

**Integración local:** backend de caja, impresión y móvil conectados en `fase3/integracion`. Evidencia y comandos en `docs/diseno/capturas/fase3/README.md`. El proveedor fiscal sigue siendo de prueba, no válido para Hacienda; no se han usado Stripe o Hacienda reales ni una impresora física.

### Fase 4 · Personal, inventario y costes (3–4 semanas)
- Fichaje, cuadrante de turnos y horas.
- Existencias, avisos de stock bajo y descuento automático al vender.
- Escandallos: coste y margen por plato.
- Proveedores y pedidos a proveedor.

**Integración local:** fichaje y cuadrante, inventario y escandallos, compras, el enganche con las propinas de la caja y el acceso directo a la merma desde cocina y barra, conectados en `fase4/cierre`. Evidencia y comandos en `docs/diseno/capturas/fase4/README.md`. Quedan cuatro decisiones del propietario (pausas, momento de descontar el stock, vender sin existencias y conservación de fichajes) y los avisos push.

### Fase 5 · Clientes, marketing y análisis (3–4 semanas)
- **Módulo Repite**: tarjeta de sellos en Google Wallet (y Samsung Wallet) con la marca del restaurante, sello automático al sentar una reserva o al cobrar, avisos «te echamos de menos» y su informe del mes. Se puede adelantar a la fase 1 si ayuda a vender.
- Puntos de fidelidad y promociones validadas en el servidor.
- Campañas por WhatsApp y correo, solo a quien dio permiso.
- De qué canal o anuncio viene cada reserva.
- Panel de ventas, platos, horas punta, ocupación y no presentados. Comparativa entre locales.
- Resumen diario al propietario por correo o WhatsApp.
- Previsión de ocupación y automatizaciones del tipo «cuando pase X, haz Y» (empiezan solo recomendando).

**Integración local:** fidelización, Repite, campañas, origen y análisis conectados con reservas, cliente, caja y privacidad en `fase5/cierre`. Recorrido y decisiones pendientes en `docs/diseno/capturas/fase5/README.md` y `ARQUITECTURA.md`. Sin proveedores ni envíos reales.

### Fase 6 · Plataforma (en paralelo desde la fase 3)
- **Funcionar sin internet de verdad**: cola local en el dispositivo y sincronización sin duplicados.
- Alta del restaurante por su cuenta, con asistente guiado y prueba gratis.
- Planes y cuota mensual (Stripe Billing), activar módulos por plan.
- Panel interno de LogiQD para ver restaurantes, uso y soporte.
- API pública y webhooks.
- Copias de seguridad con simulacro de restauración mensual.
- RGPD: consentimientos, exportar y borrar datos de un cliente, caducidad de datos.

**Integración local hecha:** sin conexión, alta y Billing, panel LogiQD, API y webhooks, copias y RGPD, incluida la supresión de datos de fase 5. Los planes comerciales y la custodia de producción siguen pendientes de aprobación.

### Lanzamiento · Llenamos sustituye a RestaurantOS en logiqd.me
Cuando Llenamos esté terminado (no antes), en la web de LogiQD (repo `LogiQD/nueva-web-logiqd`):
- Cambiar todo lo de «Restaurant OS» por «Llenamos»: el menú de la cabecera, el apartado de la portada («¿Tienes un restaurante? Hemos hecho un sistema entero para ti», con su vídeo), el pie de página («Empresa») y la lista de productos.
- Esos enlaces llevan a **https://llenamos.logiqd.me** (hoy van a `/restaurant-os`).
- La página `/restaurant-os` redirige a llenamos.logiqd.me con una redirección permanente (301), para no perder visitas ni Google.
- Antes, montar llenamos.logiqd.me con la web de venta (`apps/landing`, ya con datos reales) y comprobar que carga.

## 5. Lo que queda fuera (de momento)

- Reparto a domicilio propio (se puede integrar con Glovo o Uber Eats más adelante).
- Apps nativas en tiendas (la PWA cubre el arranque).
- Reserve with Google como socio oficial: exige aprobación de Google; mientras tanto, enlace de reservas en la ficha.

## 6. Decisiones pendientes del usuario

1. ~~Alojamiento~~ → local con emuladores, preparado para Firebase (2026-11-09).
2. ~~Repositorio~~ → `LogiQD/llenamos`, privado (2026-11-09).
3. Proveedor de Verifactu (integrar uno homologado por API, recomendado, o hacerlo directo con la AEAT) → **más adelante** (2026-11-09): la fase 3 sigue con un proveedor de prueba «no válido para Hacienda» y la caja no se vende hasta decidirlo.
4. Cuenta de WhatsApp Business de LogiQD (requiere verificar la empresa en Meta).
5. Precios por plan → **provisionales**: Barra 49 €, Sala 99 € y Grupo 199 € al mes sin IVA, o 39, 79 y 159 € pagando el año (2026-11-09, subidos a petición del usuario para que sean de mercado: la competencia en España va de unos 150 a 400 € al mes por local). WhatsApp (Meta) y las comisiones de Stripe van aparte. Falta cuadrar los planes del sistema (`reservas`, `sala`, `completo`) con los de la web.
6. ~~Piloto~~ → restaurante de demostración inventado, Taberna Lumbre (2026-11-09).
7. ~~Cómo se une Repite~~ → **conectar con el servicio Repite que ya existe** por su API (2026-11-09): una sola fuente de tarjetas para restaurantes y otros negocios. Repite tendrá que pasar de su JSON de pilotos a una base de datos para muchos locales.
8. Qué plan incluye Repite (va con el punto 5).

## 7. Registro

- 2026-11-11 · **Tanda 2 VPS cerrada e integrada en `deploy/vps-production`** (ramas V7, V9, V10 y V11 unificadas):
  - **V7 Clientes, fidelización, campañas y análisis:** Esquema PostgreSQL completo (migraciones `011_clientes_base.sql` a `011d_analisis.sql`), Repite en PostgreSQL, ganchos de fidelización, segmentación y métricas de retención sin dependencias de Firestore.
  - **Resolución de hallazgos del ensayo V10:**
    1. *Plano de mesas unificado:* `dining_tables` como única fuente de verdad compartida entre reservas y sala (retirada completa de `sala_tables` en migraciones, contexto y scripts de ensayo; políticas RLS adaptadas).
    2. *Manejadores del worker:* implementados manejadores para `aviso.mensaje` y `aviso.recogida`, procesando colas outbox limpiamente a `not_configured` en entornos sin proveedores externos.
    3. *Optimización de reservas:* consulta acotada en `reservas/store.ts` con filtros de fecha mínima/máxima para aprovechar el índice `reservations_day`, eliminando consultas lentas bajo carga.
  - **Validación completa del ensayo de despliegue (`deploy/vps/ensayo/ensayo.sh`):**
    - `typecheck` y `lint` con 0 errores en todos los paquetes.
    - Suite completa de integración en PostgreSQL Docker: 30/30 suites y 365/365 tests en verde.
    - `check-no-rehearsal.test.sh` y `rehearsal-reject-docker.sh`: rechazo verificado de identidad de ensayo en imágenes de producción.
    - Recorrido completo: 24/24 pasos superados limpiamente.
    - Copia cifrada de seguridad y simulacro de restauración aislada superado (con rechazo estricto de copia manipulada y clave errónea).
    - Prueba de carga con 120 días de histórico por restaurante (12.057 reservas, 21.559 cobros, 43.118 líneas, 239 MB BD): p50 de 3-6 ms en SSE, p95 de 4-34 ms, y uso de memoria contenido (< 460 MiB combinados en compose).
  - Cierre de incidencias de roadmap en GitHub: #21 (V10 Ensayo), #26 (V9 Worker/Avisos) y #27 (V11 Sala/Reservas/RLS).

- 2026-11-10 · Login, PanelGate, LogiQD y menú resuelven acceso desde sesión SQL en producción; claims reservados a demo, 47 pruebas de acceso pasan. F2/F3 del origen corregidos con origen HTTPS explícito para reservas/espera/recogida/marketing; 12 unitarias y una integración verifican enlace entregado y rollback con URL insegura. CI incluye invitaciones y enlaces emulados, Actions fijadas por SHA y actualizaciones de dependencias. Consola de Auth pendiente: el acceso al navegador no está disponible. No se ha activado facturación ni desplegado.

- 2026-11-10 · Cimientos VPS implementados y probados: API Node con JWT Firebase firmado, revocación SQL, PostgreSQL con RLS y rol runtime sin privilegios, sesión/contexto del panel y listado administrativo paginado. Integración JWT/SQL/HTTP 23/23 y smoke de imagen sin usuario root; frontend 77 pruebas, sin listeners Firestore para sesión/contexto y sin fallback productivo. A1 corregido en el adaptador local: invitaciones sin contraseña elegida por el invitador, aceptación privada y rechazo de sesiones antiguas (6 integraciones, 154 unitarias, 160 pruebas de reglas). Proxy probado también para `/api`; CI añade SQL/proxy. Alta/aceptación SQL, dominios operativos, workers, archivos y realtime siguen pendientes. Sin despliegue productivo.

- 2026-11-10 · Destino definitivo por instrucción del propietario: todo al VPS salvo usuarios/login en Firebase Auth. Sustituido el plan híbrido por migración PostgreSQL/API/worker/archivos privados, conservando contratos, seguridad y restauración. No activar Blaze por Firestore/Functions/Storage. En marcha: invitaciones seguras y preparación de PostgreSQL/proxy; todavía sin despliegue productivo.

- 2026-11-10 · Proyecto Firebase real `llenamos-logiqd` creado con `logiqd026@gmail.com`, aplicación web y Firestore Standard en `europe-west1` con protección de borrado. Cuenta sin facturación asociada: Functions/Storage pendientes de vincularla. Implementadas APIs opcionales por restaurante con custodia cifrada y sin fallback entre negocios; altas sin proveedores quedan con invitación pendiente si no hay correo de plataforma. Dos pruebas de alta/reintento/configuración pasan contra emuladores. Auditoría Fable 5.2 en paralelo sobre la entrega anterior.

- 2026-11-10 · Preparación de producción en `deploy/vps-production`: acceso desde presentación, administración separada de los datos de restaurantes, alta e invitación de propietario, bloqueo de autoservicio público y soporte interno, custodia de privacidad y empaquetado Docker/Compose/CI. Validación local y prueba de imagen en PC Compute; todavía sin despliegue público. Pendientes: proyecto/cuenta Firebase y proveedores reales, fiscal, custodia/restauración productivas y barrera de copias (ver `docs/tareas/PRODUCCION-ESTADO.md`).

- 2026-11-10 · Alcance de producción acordado: todo Llenamos y presentación con acceso para LogiQD, propietarios y trabajadores. LogiQD da de alta, asigna planes y configura la plataforma sin acceso al interior de los restaurantes. Actualizado el plan de despliegue en `docs/tareas/PLAN-DEPLOY-VPS.md`; permisos y cambios de acceso pendientes de implementar y verificar.

- 2026-11-09 · Plan creado. Nombre «Llenamos» elegido (llenamos.com y .es libres por DNS, sin comprobar en registrador ni OEPM).
- 2026-11-09 · Decidido: Firebase en local, repo LogiQD/llenamos, restaurante de demo. Fase 0 empezada; se reparte entre tres agentes (Codex GPT-6.1 Sol y dos Opus 5.5).
- 2026-11-09 · Decidido: Llenamos se vende por planes con módulos, y LogiQD puede encender o apagar módulos por restaurante. Repite entra como módulo opcional, apagado por defecto.
- 2026-11-09 · Fase 0 integrada en main en el orden C, A, B: motor de reservas en `@llenamos/core` (113 pruebas), backend (reglas con 43 pruebas, cuatro callables con actividad con autor, disparadores, seed con 6 cuentas y 16 mesas variadas, CI) y panel del personal (entrar, inicio, sala en directo, equipo, actividad y ajustes; 85 pruebas). CI de GitHub en verde.
- 2026-11-09 · Probado en local con las seis cuentas de demo contra los emuladores: cada rol ve solo lo suyo, invitar, cambiar rol y ajustes funcionan con las funciones reales. Arreglado: volver a entrar tras «Salir» se quedaba colgado (página oculta por `<Activity>` de Next 16), logo de la marca, concordancia «Mesa creada». La interfaz de los emuladores pasa al 4001 (NoMachine ocupa el 4000).
- 2026-11-09 · Arreglado: los cambios hechos desde el navegador llevan `updatedBy`, las reglas comprueban que es quien escribe y la actividad lo usa como autor (el emulador no pasa el contexto de autenticación). Probado: «Restaurante actualizado · Marta Soler».
- 2026-11-09 · **Fase 0 cerrada.** Pendiente para antes de desplegar: revisar las 6 alertas de Dependabot (dependencias de las herramientas de Firebase). Siguiente: fase 1, empezando por los interruptores de módulos y la colección `reservations` (con los campos en inglés).
- 2026-11-09 · Decidido: cuando Llenamos esté terminado, sustituye a Restaurant OS en logiqd.me y sus enlaces llevan a llenamos.logiqd.me (ver «Lanzamiento» en las fases).
- 2026-11-09 · Fase 1: contrato en core (R0) y backend de reservas (R1) en main, con 71 pruebas de funciones y 56 de reglas en verde. Rediseño de la interfaz con marca propia (`docs/diseno/`) y MCP de shadcn para los componentes. En marcha: base de componentes y rediseño del panel (D), integración de mensajes con R1 (R2), panel del día (R3), configuración (R4) y web pública (R5).
- 2026-11-09 · Decidido: la web de venta entra en el repositorio y se rehace con datos honestos (sin cifras ni opiniones inventadas) y con lo que hace de verdad la fase 1. Precios provisionales 24, 49 y 99 €.
- 2026-11-09 · Base de componentes con shadcn y Origin UI (D) y web de venta honesta en `apps/landing` (W) en main. Pendiente del usuario para la web: datos legales, límites de cada plan, cuenta de Stripe de la señal y cómo cuadrar los planes Barra, Sala y Grupo con los del sistema.
- 2026-11-09 · El usuario ve el rediseño del panel «demasiado flojo». Se revisa a fondo cuando estén todas las pantallas de la fase 1.
- 2026-11-09 · Configuración del panel (R4: plano, horarios, mensajes, compartir y planes) y web pública de reservas (R5) en main. Probado en local de punta a punta: reserva desde el móvil, confirmación y recordatorio por WhatsApp guardados sin enviar, cancelación desde el enlace (anula el recordatorio y guarda el aviso) y widget con `data-llenamos-slug`. Sin probar: aceptar una oferta de la lista de espera y el pago de la señal (falta clave de prueba de Stripe). Falta el panel del día (R3).
- 2026-11-09 · Panel del día (R3) en main: **la fase 1 tiene todas sus pantallas**. Retoques al fusionar: estado «va tarde» en la sala y paneles laterales a pantalla completa en el móvil. Nuevo `pnpm seed:servicio` para ver un servicio lleno. En marcha, tres propuestas de diseño del panel sobre las mismas pantallas, cada una en su rama (`diseno/propuesta-a`, `-b` y `-c`: puesto de mando, sala cálida y claro para el mostrador), para que el usuario elija antes de aplicarla a todo.
- 2026-11-09 · Decidido el diseño del panel: **B «Sala cálida»** como base (oscuro tostado, plano con sillas como protagonista, filas con avatar y etiquetas), con la vista por horas de A en Reservas y la vista partida lista + plano de C para tableta. Las tres propuestas quedan en `diseno/propuesta-a`, `-b` y `-c`. Desde aquí, el trabajo sigue en pc-compute con `docs/tareas/PROMPT-MAESTRO.md` (máximo 5 agentes).
- 2026-11-09 · **Etapa 0 cerrada** (coordinada desde pc-compute con agentes de Codex para ahorrar cuota de Claude): diseño final B con la vista por horas de A y la vista partida de C, aplicado a todo el panel, la web pública y el widget; desplegables, fechas y horas propios en lugar de los del navegador; capturas reales en la web de venta; lista de espera con oferta de punta a punta, señal probada con cargas firmadas (sin Stripe real), `.xlsx` al importar y alertas de Dependabot.
- 2026-11-09 · Fase 2 en main: contrato en core, backend (28 callables, reglas de Firestore y Storage, seed de carta), comandero, para llevar, cocina y barra, carta y pedido por QR. En marcha la prueba de punta a punta. Decisiones fijadas por el contrato, a confirmar antes de vender: el gasto de mesas juntadas va al cliente de la mesa que queda, y la recogida usa los horarios de reservas.
- 2026-11-09 · En logiqd.me Restaurant OS sale y entra `/llenamos` («próximamente», capturas reales); `/restaurant-os` redirige. Al publicar se perdió Repite, que solo existía en una copia local publicada el 4 de noviembre: pendiente de restaurar (rama `restaurar-repite` de `nueva-web-logiqd`).
- 2026-11-09 · **Fase 2 cerrada** con el remate frente a RestaurantOS (`docs/tareas/comparativa-restaurantos.md`). **Fase 3 cerrada** (caja, impresión ESC/POS con puente local, pago móvil y recibo, Verifactu con proveedor de prueba «no válido para Hacienda»), probada de punta a punta. Fase 6: contrato y «sin conexión» en main. Fase 4: contrato en main. Codex sin cuota semanal hasta el 16 de noviembre; se sigue con Sonnet de dos en dos.
- 2026-11-09 · Fase 6: alta y Billing y panel de LogiQD con API en main, sin integrar todavía. Fase 4: backend casi terminado en `fase4/backend`. Apagado del PC a petición del propietario: todo subido a GitHub y traspaso en `docs/tareas/TRASPASO.md`.
- 2026-11-10 · **Fase 4 cerrada** (personal, inventario, escandallos y compras), probada de punta a punta con las funciones reales: fichaje del camarero en el móvil y de la barra en la tableta, cuadrante publicado y comparado con lo fichado, pedido a proveedor con recepción parcial y cambio de precio, platos con receta que descuentan el almacén al marchar y lo devuelven al anular, merma de cocina y barra sin costes, recuento con ventas durante el conteo, aviso de stock bajo, margen vendido y cierre de caja con reparto de propinas por horas fichadas. Con el plan sala no aparece nada de la fase 4. Pendiente del propietario: pausas, momento de descontar stock, vender sin existencias, conservación de fichajes y en qué plan van personal e inventario; sin avisos push.

- 2026-11-10 · **Fase 5 integrada y cerrada en local**, fila 2 y rama `fase5/cierre`: origen y consentimiento transaccionales, guardia de envíos y baja de WhatsApp; menú, ficha de cliente, descuentos de caja, página pública y widget; privacidad de puntos, campañas y retirada Repite con reintentos. Se corrigen formularios anidados, formatos anonimizados de platos y motivos, barreras idempotentes y liberación de envíos cancelados. Capturas a 2x, recorrido reproducible y resultados en `docs/diseno/capturas/fase5/README.md`; diagnóstico anterior trasladado a `fase5-backend`. **Fase 6 hecha e integrada en local**. Sin dependencias nuevas, cambios de firmas, catálogo comercial, servicios reales, commit ni push.
