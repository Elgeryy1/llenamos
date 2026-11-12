# Fase 4 · Fichaje y cuadrante · capturas

Capturas reales a 2x contra los emuladores de `demo-llenamos` (`pnpm seed`, `pnpm seed:servicio` y `scripts/seed-fase4.ts`), con las cuentas de demostración de `/entrar` (contraseña `Llenamos2026!`). Las pruebas táctiles usan toques (`tap`) con el dispositivo táctil de Playwright; el escritorio, ratón. Cada captura sale de un recorrido que comprueba además el comportamiento (ver «Comprobado»).

## Móvil (390 × 844, camarero)

| Archivo | Qué enseña |
|---|---|
| `01-movil-fuera` | Sin fichar: un solo botón grande, turnos publicados de la semana y últimos fichajes |
| `02-movil-trabajando` | Entrada fichada con la hora del servidor; contador y marcas de hoy |
| `03-movil-en-pausa` | En pausa: volver de la pausa o salir |
| `04-movil-confirmar-salida` | La salida pide confirmación |
| `05-movil-salida-hecha` | Salida fichada |
| `06-movil-fichaje-olvidado` | Fichaje abierto de otro día: no se ficha, se avisa a un encargado |
| `37-cuadrante-movil`, `38-horas-movil` | Cuadrante por día y hoja de horas del encargado en el móvil |

## Puesto de tableta (1180 × 820, táctil, sesión de encargada)

| Archivo | Qué enseña |
|---|---|
| `10-tableta-puesto` | Rejilla del equipo con su estado |
| `11-tableta-pin-dos-cifras` | Teclado de PIN de 64 px; los puntos cuentan, no enseñan las cifras |
| `12-tableta-pin-incorrecto` | PIN incorrecto con los intentos que quedan |
| `13-tableta-entrada-hecha`, `14-tableta-puesto-con-fichados` | Fichaje hecho y puesto actualizado en directo |
| `15-tableta-olvidado` | Una persona con fichaje olvidado no ficha en el puesto |

## Encargado, escritorio (1440 × 900)

| Archivo | Qué enseña |
|---|---|
| `20-hoy` | Quién está trabajando y turnos de hoy frente a lo fichado |
| `21-horas`, `27-horas-mes` | Hoja de horas por semana y por mes, con el fichaje olvidado a resolver |
| `22-horas-cerrar-olvidado`, `22b-horas-cerrar-solapado` | Cerrar un olvidado con motivo; el servidor rechaza una hora que se pisa con otro fichaje |
| `23-horas-corregir` | Corregir con previsión de horas y motivo obligatorio |
| `24-horas-anadir-a-mano`, `25-horas-anular`, `26-horas-historial` | Fichaje a mano, anulación con motivo e historial de auditoría |
| `40-ajustes`, `41-ajustes-pin` | Ajustes de personal y PIN de cada persona |

## Cuadrante (tableta 1180 × 820 táctil)

| Archivo | Qué enseña |
|---|---|
| `30-cuadrante-tableta` | Semana por persona y día, con avisos de descanso y de horas |
| `31-cuadrante-comparar` | Comparación con lo fichado: a su hora, tarde, no ha fichado, aún no toca |
| `32-cuadrante-semana-vacia`, `33-cuadrante-copiada-borrador` | Copiar la semana anterior: turnos en borrador (borde punteado) |
| `34-cuadrante-nuevo-turno`, `35-cuadrante-turno-pisado` | Nuevo turno y rechazo de un turno que se pisa |
| `36-cuadrante-publicado` | Semana publicada |

## Comprobado en el recorrido

Doble toque en «Fichar entrada» sin error de «ya abierto»; ciclo completo de entrada, pausa, vuelta y salida en el móvil y en el puesto; PIN incorrecto rechazado con intentos restantes; cocina no entra en las horas del equipo; cerrar un olvidado a una hora que se pisa lo rechaza el servidor; corregir sin motivo se rechaza; fichaje a mano, anulación con motivo e historial; copiar semana, turno que se pisa rechazado, publicar y que el camarero vea su cuadrante; ajustes guardados y recuperados al recargar.
