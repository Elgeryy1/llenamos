# Alta y Billing · Sala cálida

Capturas reales a 2x en Chromium contra los emuladores de la fila 4, proyecto demo-llenamos. Escritorio 1440 × 1000 CSS; móvil 390 × 844 CSS. No se ha usado Stripe real ni realizado cargos. Las ofertas son provisionales, pendientes de aprobación.

| Captura | Recorrido |
|---|---|
| 01-acceso | Acceso al asistente y aviso de prueba sin tarjeta |
| 02-plano | Ocho mesas con formas y sillas, mismo componente que Sala |
| 03-horarios | Turnos de comida y cena, lunes cerrado, horas con Desplegable |
| 04-prueba | Catálogo provisional y prueba sin tarjeta |
| 05-revision | Resumen, condiciones explícitas de prueba local y aviso sin cargos |
| 06-restaurante-creado | Alta recuperada tras perder la respuesta posterior al commit |
| 07-planes-sin-claves | Prueba, módulos, catálogo, facturación sin configurar y baja |
| 08-planes-movil | Pantalla de planes en móvil |

Reproducir desde la raíz con `pnpm exec tsx scripts/billing-navegador.ts`, con web en 3014 y emuladores de fila 4. Preparación y comandos en `functions/src/fase6-billing/README.md`. La prueba entra primero con la cuenta demo del propietario y después crea un acceso ficticio en Auth local para que pueda repetirse sin conceder dos pruebas al mismo uid.

El navegador recarga el plano y comprueba que conserva ocho mesas. Después intercepta completarAlta, deja que el servidor confirme la transacción, descarta su respuesta, recarga y reintenta la misma petición. Termina con un solo restaurante y una sola prueba. La pantalla de planes comprueba el aviso explícito de ausencia de cargos. `resultado.json` guarda el slug ficticio del recorrido y los errores de navegador (vacíos).

No se ha añadido la entrada al menú compartido. Datos para el coordinador: Restaurante → Plan y facturación → `/panel/planes` → `planes.ver`, sin módulo requerido. El alta entra por `/alta`.
