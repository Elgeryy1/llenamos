# Estado de Llenamos

Qué trae cada fase y cómo va. Se actualiza al cerrar cada tanda de trabajo. El detalle técnico está en [`PLAN.md`](../PLAN.md) (fases y decisiones) y [`ARQUITECTURA.md`](../ARQUITECTURA.md) (contrato).

**Actualizado:** 10 de noviembre de 2026, fase 5 cerrada y fase 6 integrada en local. Para retomar: [`tareas/TRASPASO.md`](tareas/TRASPASO.md).

| Fase | Qué es | Estado |
|---|---|---|
| 0 · Cimientos | Base del sistema, roles y seguridad | ✅ Hecha |
| 1 · Reservas | El producto con el que se sale a vender | ✅ Hecha |
| Etapa 0 · Diseño | Diseño final aplicado a todo | ✅ Hecha |
| 2 · Sala y cocina | Carta, comandero, QR, cocina y barra | ✅ Hecha, probada y rematada frente a RestaurantOS (falta probar los avisos push en un móvil real) |
| 3 · Caja y tickets legales | Cobrar, dividir, arqueo, Verifactu | ✅ Hecha y probada de punta a punta (Verifactu con proveedor de prueba: no se puede vender hasta elegir proveedor) |
| 4 · Personal, inventario y costes | Fichaje, turnos, existencias, escandallos | ✅ Hecha y probada de punta a punta (quedan cuatro decisiones del propietario y los avisos push) |
| 5 · Clientes, marketing y análisis | Repite, campañas, ventas, previsión | ✅ Hecha e integrada en local, con Repite y envíos de prueba |
| 6 · Plataforma | Sin internet, alta propia, planes, API, RGPD | ✅ Hecha e integrada en local, incluida privacidad de la fase 5; planes y custodia de producción pendientes de decisión |
| Lanzamiento | llenamos.logiqd.me y sustituir a Restaurant OS | ⏳ Cuando lo diga el propietario. En logiqd.me ya está `/llenamos` con «próximamente» |

Todo funciona **solo en local**, con los emuladores de Firebase. No hay nada desplegado ni se cobra nada real.

---

## Fase 0 · Cimientos ✅

- Varios restaurantes, cada uno con sus locales, zonas y mesas. Cada uno ve solo lo suyo (comprobado en la interfaz, en el servidor y en las reglas de la base de datos).
- Personal con roles: propietario, encargado, camarero, cocina y barra.
- Registro de actividad que no se puede borrar, con quién hizo cada cosa.

## Fase 1 · Reservas ✅

- Editor del plano: arrastrar mesas, zonas y qué mesas se pueden juntar.
- Horarios, turnos, duración según el grupo, capacidad y días especiales.
- Página de reservas con la marca del restaurante, widget para su web y enlace para Instagram y Google Maps, en castellano, catalán e inglés.
- Reservas del día en lista, en vista por horas y en vista partida con el plano (tableta); sala en directo.
- Confirmación y recordatorio por WhatsApp y correo; confirmar o cancelar respondiendo. Sin claves de proveedor no se envía nada y se dice.
- Señal con tarjeta contra los que no se presentan (Stripe; probada con pagos simulados, falta probar con una clave de prueba).
- Lista de espera que avisa sola cuando se libera una mesa.
- Mesa sugerida, que decide el encargado.
- Ficha de cliente con visitas, no presentados, notas y alergias.
- Importar reservas desde Excel (`.csv` y `.xlsx`).
- Petición de reseña en Google al día siguiente.
- LogiQD enciende o apaga módulos por restaurante.

## Etapa 0 · Diseño ✅

- Diseño «Sala cálida» (oscuro tostado, plano con sillas) con la vista por horas y la paleta de órdenes (Ctrl K) de la propuesta A y la vista partida de la C.
- Aplicado a todo el panel, la web pública de reservas y el widget. Desplegables, fechas y horas propios, nunca los del navegador.
- Capturas reales en la web de venta (`apps/landing`). Capturas de cada pantalla en [`docs/diseno/capturas/`](diseno/capturas/).

## Fase 2 · Sala y cocina ✅

**Hecho y probado de punta a punta** (47 capturas en [`docs/diseno/capturas/fase2/`](diseno/capturas/fase2/)):

- Carta digital por local: categorías, platos, variantes, extras, los 14 alérgenos, fotos, agotados y menú del día, en tres idiomas.
- Comandero del camarero en móvil o tableta, con pases (bebidas, primeros, segundos, postres).
- Pedido desde la mesa por QR o NFC, con aprobación del encargado; llamar al camarero y pedir la cuenta.
- Pantallas de cocina y barra por estación, con tiempos y avisos solo cuando algo se retrasa.
- Tareas de sala con dueño («voy yo»): dos personas no pueden coger la misma.
- Mover, juntar y separar mesas sin pisar reservas. Sentar una reserva abre la mesa y su gasto se apunta al cliente.
- Para llevar con hora de recogida y seguimiento.
- Precios siempre calculados en el servidor y en céntimos.

**Rematado** (lo que le faltaba frente a RestaurantOS, ver [`comparativa-restaurantos.md`](tareas/comparativa-restaurantos.md)):

- Sala: la comanda a medias no se pierde ni se envía dos veces; estados en el plano; recogida con los platos; pedir más rápido; horario para pedir por QR; bandeja de comandas; llamar al camarero con motivo.
- Cocina: nota general del pedido; datos de recogida; cómo marcha un pedido por QR con pases; varias acciones a la vez; contador de raciones; avisos al móvil con la pantalla bloqueada; varios tickets a la vez en la tableta.
- Carta: buscar y filtrar por alérgenos; volver a descargar el QR sin invalidar el impreso; correos de para llevar; agotar una variante; destacados; idioma recordado.

**A confirmar antes de vender:** al juntar mesas de clientes distintos, el gasto va al cliente de la mesa que queda; la recogida usa los horarios de reservas.

## Fase 3 · Caja y tickets legales ✅

**Hecho:** el contrato (cuentas, cobros, dividir la cuenta, IVA, arqueo, propinas, facturas y registro Verifactu con huella encadenada y QR, comprobado contra el esquema oficial de la AEAT), el backend de caja (cobros sin duplicar aunque se repitan o coincidan, arqueo, facturas y rectificativas) y la pantalla de caja (`/panel/caja`).

**También hecho:** impresión ESC/POS con un puente local (comandas, tickets, facturas y cajón), pago desde el móvil con Stripe y recibo digital, y la prueba de punta a punta (22 capturas en `docs/diseno/capturas/fase3/`). Falta probar con una impresora y un cajón reales y con una clave de Stripe.

Trae: cobro en efectivo, tarjeta y mixto; pagos parciales; dividir la cuenta por partes iguales, por platos o por importe; invitaciones y anulaciones con motivo; devoluciones; apertura y cierre de caja con arqueo; factura simplificada y completa y rectificativas; propinas y su reparto.

> [!WARNING]
> **Sin proveedor de Verifactu elegido** (decisión pendiente del propietario), los tickets salen con un proveedor de prueba marcado «no válido para Hacienda». La caja no se puede vender hasta decidirlo.

## Fase 4 · Personal, inventario y costes ✅

**Hecho:** el contrato, el backend (31 callables, reglas y los procesos de consumo), las pantallas y la prueba de punta a punta en un navegador real (`scripts/fase4-navegador.ts`, capturas a 2x y recorrido en `docs/diseno/capturas/fase4/`).

- **Personal.** Fichar entrada, pausa, vuelta y salida desde el móvil con la hora del servidor; puesto de tableta con PIN; hoja de horas con correcciones, fichajes olvidados (los cierra el encargado con motivo) y todo auditado; cuadrante semanal por persona y día con avisos de descanso y horas, copiar semana, publicar y comparar con lo fichado.
- **Inventario.** Existencias con avisos de stock bajo, ingredientes, merma desde cocina y barra (sin ver nunca un importe), ajustes, recuento por pasos con reconciliación de las ventas hechas mientras se cuenta y libro de movimientos con valor para quien ve costes.
- **Descuento automático.** Al marchar un plato con receta el almacén baja solo (disparador real) y una anulación antes de preparar lo devuelve; cada línea guarda su coste y su precio de ese momento.
- **Escandallos.** Receta con versiones, coste teórico y margen por plato, y margen vendido con el coste histórico.
- **Compras.** Proveedores y formatos, sugerencia de pedido, pedido en borrador, enviado (lo marca el encargado: Llenamos no envía nada), recepción parcial con el precio del albarán y aviso de cambio de precio, cierre sin completar y compra directa.
- **Propinas por horas (enganche con la fase 3).** El reparto de propinas de la caja pide las horas fichadas durante esa caja, las precarga (el encargado las puede cambiar), avisa de los fichajes olvidados que aún no cuentan y de las cajas sin fichajes, y con el módulo de personal apagado deja el reparto manual de siempre.
- **Acceso directo a «Registrar merma»** en las pantallas de cocina y barra, con el mismo diálogo del inventario, solo con permiso de merma y el módulo de inventario activo.
- **Planes.** Personal e inventario entran solo en el plan completo. Con el plan sala no aparece nada de la fase 4 (menú, pantallas ni botones) y el servidor rechaza sus llamadas. Cada rol ve lo suyo: la encargada todo, el camarero solo su fichaje, cocina y barra su fichaje y las existencias.

**Cómo se probó:** emuladores de Firebase con las funciones reales (para que salten los disparadores de consumo), `pnpm seed`, `pnpm seed:servicio`, `pnpm seed:caja` y el seed de la fase 4. El recorrido automático (`scripts/fase4-navegador.ts`, con instrucciones en `docs/diseno/capturas/fase4/README.md`) recorre: el camarero ficha en el móvil y la barra en la tableta, la encargada publica el cuadrante y compara, un pedido a proveedor con recepción parcial y cambio de precio, la sala marcha platos y el stock baja solo, una anulación lo devuelve, cocina y barra registran merma sin ver costes, un recuento con ventas durante el conteo, el aviso de stock bajo y la sugerencia de pedido, escandallos con margen vendido, cobro con propina, cierre de caja y reparto por horas fichadas, un fichaje olvidado cerrado por el encargado, la salida del camarero, y la comprobación de menús por rol y del plan sala.

> [!NOTE]
> Fichar y cerrar la caja suceden en segundos durante la prueba, así que los minutos repartidos son pocos (1 y 2). La cuenta es la de siempre y se repite con más tiempo en el servicio real.

**Decisiones pendientes del propietario** (con su recomendación, en `ARQUITECTURA.md`):

| Decisión | Recomendación |
|---|---|
| Pausas: ¿cuentan como trabajadas? | Descontarlas por defecto y dejarlo configurable; confirmar con el convenio |
| Cuándo se descuenta el stock | Al marchar el plato; si prefiere al servir o al cobrar, cambia una sola función |
| Vender sin existencias | Permitirlo y dejar el stock en negativo con aviso |
| Conservación de los fichajes frente al borrado por RGPD | Cuatro años a disposición de inspección, a confirmar con el asesor laboral |
| En qué plan comercial van personal e inventario | Solo en el plan completo; falta cuadrarlo con la decisión de planes |

**Falta:** avisos push de stock bajo y de cambios en el cuadrante (hoy el aviso es un documento visible en el panel); fichar sin conexión; lotes y caducidades, elaboraciones intermedias, vacaciones y bajas, envío real de pedidos a proveedores y margen de menús del día (esto último es fase 5).

## Fase 5 · Clientes, marketing y análisis ✅

- Programa de puntos, premios, canjes y promociones con revisión y cálculo del servidor, integrados en cliente y cuenta de caja. Los ajustes se muestran como descuentos.
- Repite mediante su adaptador y doble HTTP local: una sola operación de sello al sentar y cobrar una visita, con reintentos. La API real de Repite sigue pendiente en su repositorio.
- Origen de campaña, anuncio o canal guardado con cada reserva, también desde widget, teléfono, panel, importación y lista de espera.
- Consentimientos opcionales y separados, guardados con la reserva pública. Campañas solo con permiso vigente, guardia al enviar, baja por enlace o palabras de WhatsApp y cancelación de lo pendiente.
- Ventas, comparativa, margen histórico, origen, previsión, resumen diario capturado y automatizaciones que recomiendan y permiten descartar sin ejecutar acciones. Sin base anterior se indica «Sin base».
- Menú por permiso y módulo: propietario y encargado configuran; el camarero opera desde cliente y caja. Cocina, barra y el plan sala no reciben entradas de fase 5.
- Privacidad cierra puntos, anonimiza movimientos y respuestas, elimina destinatarios y registros y encola la retirada de la tarjeta antes de borrar su enlace. Conserva sus identificadores para reintentar.

**Prueba y capturas a 2x:** [`fase5/README.md`](diseno/capturas/fase5/README.md), con el recorrido versionado en `scripts/fase5-navegador-integracion.ts`. El diagnóstico original del backend está separado en [`fase5-backend`](diseno/capturas/fase5-backend/README.md).

**Decisiones del propietario:** planes de los módulos nuevos y precio de Repite; puntos, caducidad y condiciones; cuándo sellar; compatibilidad de promociones; quién lanza campañas, frecuencia y horario; textos y política de privacidad aprobados; cuenta y plantillas de WhatsApp; hora del resumen. Se conservan las propuestas de `ARQUITECTURA.md`, sin convertirlas en decisiones comerciales. Las casillas usan una política explícita de demostración en emuladores y requieren configuración aprobada fuera de ellos.

## Fase 6 · Plataforma ✅

**Hecha e integrada en local:** cola sin conexión con idempotencia, alta con prueba gratis, Billing con proveedor de prueba, panel LogiQD, API y webhooks firmados, copias con restauración aislada y RGPD con identidad verificada. Se amplía el inventario para la fidelización y campañas de fase 5. El borrado mantiene legibles los esquemas de sala, caja y análisis y conserva originales fiscales restringidos y barreras idempotentes.

Evidencia de plataforma en [`fase6-integracion`](diseno/capturas/fase6-integracion/README.md). Privacidad y copias se prueban con Auth, Firestore y Storage, clave local de custodia y sin Functions; los recorridos con disparadores usan también Functions. Todo contra `demo-llenamos`.

Quedan las decisiones comerciales de planes y límites, los proveedores reales y la custodia, retención y bases jurídicas de producción. No hay despliegue ni cargos reales.

## Lanzamiento ⏳

- Llenamos en llenamos.logiqd.me con la web de venta.
- En logiqd.me ya se ha quitado Restaurant OS: `/llenamos` anuncia Llenamos como «próximamente» con capturas reales y `/restaurant-os` redirige ahí.
- Desplegar en la nube solo cuando el propietario lo diga.

## Decisiones pendientes del propietario

| Decisión | Para qué fase | Recomendación |
|---|---|---|
| Proveedor de Verifactu | 3 | Proveedor homologado por API |
| Quién cobra la señal y el pago móvil: Stripe de cada restaurante o de LogiQD | 3 | Cada restaurante con su cuenta (Stripe Connect) |
| Cuadrar planes Barra, Sala y Grupo con los módulos y sus límites | 6 | Barra = reservas, Sala = reservas + sala y cocina, Grupo = todo |
| Repite: en qué plan entra (conectar con el existente ya está decidido) | 5 | Módulo opcional aparte en cualquier plan |
| Cuenta de WhatsApp Business verificada en Meta | Envíos reales | |
| Datos legales para la web (titular, NIF, domicilio) | Lanzamiento | |
| Cuándo lanzar y gastar en la nube | Lanzamiento | |
