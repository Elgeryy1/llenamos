# Decisiones del proyecto

- 2026-11-10 · Firebase se conserva exclusivamente para usuarios y login; base de datos, archivos, lógica de servidor, procesos, tiempo real y copias irán al VPS, para aprovechar la infraestructura propia y evitar depender de Firestore, Storage y Cloud Functions. Sustituye el despliegue híbrido anterior; no activar facturación Firebase para ese plan.

- 2026-11-10 · Crear el proyecto Firebase de Llenamos bajo `logiqd026@gmail.com`, por indicación del propietario; autenticar esa cuenta antes de crear recursos.
- 2026-11-10 · Las APIs de servicios de cada restaurante se pedirán al darlo de alta y serán opcionales, pudiendo quedar en blanco; lo no configurado queda identificado y desactivado, para permitir altas sin contratar proveedores de antemano. No compartir credenciales entre restaurantes.

- 2026-11-10 · El despliegue debe incluir todo Llenamos y la web de presentación, con entrada para LogiQD, propietarios y trabajadores; LogiQD da de alta restaurantes y configura su plan, módulos y ajustes de plataforma, sin ver sus datos operativos ni entrar en su panel, para separar la administración del servicio de la gestión privada de cada restaurante. Requisito acordado, pendiente de implementar y verificar.

- 2026-11-12 · Las claves de los proveedores (Stripe, WhatsApp, correo, fiscal y Repite) las pone cada restaurante desde su configuración; los cobros (señal de reserva y cobros de caja) van con la Stripe del propio restaurante, para no intermediar dinero ni compartir credenciales.
- 2026-11-12 · LogiQD no contrata Verifactu ni otros proveedores fiscales: ofrece la integración con la API que ponga el restaurante y le ayuda a configurarla, porque el cumplimiento fiscal es del restaurante.
- 2026-11-12 · Los fichajes se pueden exportar a petición del trabajador, pero no se borran mientras dure la obligación legal de conservar el registro de jornada (4 años, art. 34.9 del Estatuto de los Trabajadores); pasado ese plazo se anonimizan.
- 2026-11-12 · El alta propia de restaurantes sigue apagada: los da de alta LogiQD, para controlar quién entra durante el piloto.
- 2026-11-12 · Autorizado el despliegue en el VPS y el lanzamiento en `llenamos.logiqd.me` (presentación) y `app-llenamos.logiqd.me` (aplicación), por indicación del propietario.
