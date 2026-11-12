# Fase 4 integrada · personal, inventario y costes

Recorrido de punta a punta en `demo-llenamos`, rama `fase4/cierre`, con las cuentas de demostración, un navegador real (Chromium con Playwright, a 2x) y **los emuladores con las funciones de verdad** (sin ellas no saltan los disparadores de consumo). Nada de la nube, ninguna respuesta interceptada y ninguna cuenta ni servicio externo. Los tickets conservan «no válido para Hacienda».

El guion es `scripts/fase4-navegador.ts`. Deja un resumen saneado en [recorrido.json](recorrido.json) (capturas, comprobaciones y llamadas hechas, sin tokens).

## Repetir

Desde un worktree con `pnpm install` y `pnpm funciones:build` hechos. Con la fila de puertos 2 (Auth 9103, Firestore 8097, Functions 5013, Storage 9213, Hub 4412, Logging 4512, Eventarc 9312, Tasks 9512 y web 3012), copiando `firebase.json` a `firebase.agente2.json` con esos puertos y poniendo el websocket de Firestore en el puerto de la interfaz (que se apaga):

```bash
npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
```

En otra terminal, con `apps/web/.env.local` copiado de `.env.example` y los `NEXT_PUBLIC_*_EMULATOR_PORT` de la fila, y la web levantada con `pnpm --filter web exec next dev --port 3012`:

```bash
export GCLOUD_PROJECT=demo-llenamos FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 METADATA_SERVER_DETECTION=none
pnpm seed && pnpm seed:servicio && pnpm seed:caja && npx tsx scripts/seed-fase4.ts
npx tsx scripts/fase4-navegador.ts
```

Dura unos siete minutos porque espera minutos reales de reloj (el fichaje guarda minutos exactos y el reparto de propinas cuenta lo fichado). Para empezar de cero, vaciar los emuladores antes de sembrar (`DELETE http://127.0.0.1:8097/emulator/v1/projects/demo-llenamos/databases/(default)/documents` y `DELETE http://127.0.0.1:9103/emulator/v1/projects/demo-llenamos/accounts`). Con `FASE4_SOLO=menu,compras` se ejecutan solo algunos pasos (`menu`, `cuadrante`, `entrada`, `compras`, `sala`, `merma`, `recuento`, `escandallos`, `pausa`, `vuelta`, `caja`, `propinas`, `salida`, `modulos`), aunque varios dependen de los anteriores. `FASE4_WEB`, `FASE4_FUNCIONES`, `FASE4_AUTH` y `FASE4_SALIDA` cambian puertos y carpeta.

Los procesos programados (`revisarFichajesAbiertos` y `reconciliarConsumos`) no corren en el emulador sin Pub/Sub: el fichaje olvidado de Lucía lo deja ya marcado el seed. El disparador de consumo (`consumirPorLinea`) sí es el real.

## El recorrido

1. **Menú por rol** (01). La encargada ve fichaje, personal, inventario, escandallos y compras; el camarero solo su fichaje; cocina y barra su fichaje y las existencias. Ningún otro enlace de la fase 4.
2. **Cuadrante** (02 a 04). La encargada ajusta el turno de hoy del camarero y publica la semana siguiente, que estaba en borrador.
3. **Fichaje** (05 a 08). El camarero ficha la entrada en el móvil (hora del servidor) y la barra en la tableta con PIN y la sesión de la encargada.
4. **Compras** (09 a 13). Borrador desde la sugerencia, y un pedido de la carnicería marcado como enviado por el encargado y recibido en dos veces: llegan 2 de 3 bandejas de entrecot a 35,50 € (antes 34,00 €). El pedido queda «recibido en parte», sale el aviso de cambio de precio (+4,41 %), el entrecot sube 4 kg y el coste medio cambia.
5. **Sala** (14 y 15). Con la comida retenida el almacén no se toca. Al marchar, el disparador real descuenta las recetas (bravas, hamburguesa y agua) y cada línea guarda su coste y su precio del momento. Anular la hamburguesa antes de prepararla devuelve carne, pan y patatas como movimientos propios.
6. **Cocina y barra** (16 a 21). «Registrar merma» junto a la estación, con el mismo diálogo del inventario: ni el diálogo, ni la pantalla, ni la respuesta del servidor llevan un importe. Cocina no entra en escandallos. La encargada ve esa merma valorada en el libro de movimientos.
7. **Recuento** (22 a 27). Se cuenta aceite (2,3 l) y huevos (20) y, mientras tanto, la sala vende unas bravas (40 ml de aceite). La reconciliación descuenta lo vendido: el aceite sale con −160 ml de diferencia (no −120) y queda en 2,26 l, lo contado menos lo vendido después. Los huevos bajan del mínimo, se abre el aviso de stock bajo y la sugerencia de pedido propone cubetas.
8. **Escandallos** (28 y 29). Coste teórico y margen de cada plato, y margen vendido con el coste de ese momento.
9. **Pausa y cuadrante frente a lo fichado** (30 a 33). El camarero hace una pausa y vuelve; el encargado compara el cuadrante con lo fichado (a su hora) y mira quién está dentro.
10. **Caja** (34). Cobro en efectivo de 15,00 € con 2,00 € de propina y 20,00 € entregados (3,00 € de cambio) y cierre de caja sin descuadre.
11. **Propinas por horas** (35 a 39). La pantalla de la caja pide `horasParaPropinas`, precarga los minutos fichados durante esa caja (el camarero con su fichaje todavía abierto, descontada la pausa, y la barra) y avisa del fichaje olvidado de Lucía, que no cuenta. El encargado lo cierra en la hoja de horas con salida y motivo; el aviso desaparece y el reparto de 2,00 € sale exacto por restos mayores (1,33 € y 0,67 € para 2 y 1 minutos).
12. **Salida** (40 y 41). El camarero ficha la salida con confirmación; el fichaje cierra con sus minutos y su pausa.
13. **Módulos y plan** (42 a 46). Una caja sin fichajes lo dice y deja el reparto manual. Sin el módulo de personal el reparto es el manual de la fase 3 y `horasParaPropinas` se rechaza. Con el plan sala ningún rol ve nada de la fase 4 (ni en el menú ni como botón de merma en cocina), el inventario a mano explica que no está activo y el servidor rechaza `fichar` y `registrarMerma`. Al acabar se restaura el plan.

Los minutos repartidos son pocos (1 y 2) porque la caja se abre y se cierra en unos minutos de prueba. La cuenta es la misma con turnos de horas.

## Capturas

Escritorio 1440 x 900 CSS, tableta 1180 x 820 y móvil 390 x 844. Los archivos tienen el doble de resolución, las de página completa conservan toda su altura y se comprueba que no hay desbordamiento horizontal. Solo se oculta el indicador de desarrollo de Next.

| Captura | Qué enseña |
|---|---|
| `01-menu-encargada.png` | Menú de encargada: solo lo que su rol puede usar de la fase 4 |
| `01-menu-camarero.png` | Menú de camarero: solo lo que su rol puede usar de la fase 4 |
| `01-menu-cocina.png` | Menú de cocina: solo lo que su rol puede usar de la fase 4 |
| `02-cuadrante-esta-semana.png` | Cuadrante de la semana en curso, publicado: el turno de hoy del camarero ajustado por el encargado |
| `03-cuadrante-semana-siguiente-borrador.png` | La semana siguiente, todavía en borrador: nadie del equipo la ve |
| `04-cuadrante-semana-siguiente-publicada.png` | La semana siguiente publicada; el equipo ya la ve en su fichaje |
| `05-movil-antes-de-fichar.png` | El camarero en el móvil: ve su turno de hoy publicado y un único botón grande |
| `06-movil-trabajando.png` | Entrada fichada con la hora del servidor |
| `07-tableta-pin.png` | Puesto de tableta: la persona toca su nombre y escribe su PIN en el teclado grande |
| `08-tableta-nora-dentro.png` | Tras fichar, el puesto enseña quién está dentro en directo |
| `09-compras-sugerencia.png` | La sugerencia propone lo que falta (bacon bajo mínimo) y avisa de los ingredientes sin formato de proveedor |
| `10-compras-borrador-desde-sugerencia.png` | El borrador sale de la sugerencia; los precios los pone el servidor desde el formato guardado |
| `11-compras-confirmar-envio.png` | Llenamos no envía nada al proveedor: el encargado confirma que lo ha pedido él |
| `12-compras-recepcion-parcial.png` | Recepción parcial: llegan 2 de 3 bandejas de entrecot a 35,50 € (antes 34,00 €) y el aviso de cambio de precio sale al teclear |
| `13-compras-resultado.png` | Resultado del albarán: pedido recibido en parte, lo que falta y el cambio de precio con su variación |
| `14-sala-pedido-retenido.png` | Pedido de la mesa con comida retenida: todavía nada ha marchado y el almacén sigue igual |
| `15-inventario-movimientos.png` | El libro de movimientos (solo con permiso de costes): ventas, anulación y merma, cada una con su valor |
| `16-cocina-acceso-merma.png` | La pantalla de cocina ofrece "Registrar merma" junto a la estación, sin enseñar ningún coste |
| `17-cocina-merma-dialogo.png` | El mismo diálogo del inventario: ingrediente, cantidad, motivo y nota; solo cantidades, nunca importes |
| `18-cocina-merma-hecha.png` | Merma apuntada: confirmación con lo que queda, sin costes |
| `19-cocina-escandallos-sin-acceso.png` | Cocina no ve escandallos ni costes: el panel se lo dice |
| `20-barra-movil-acceso-merma.png` | En el móvil de la barra el acceso a la merma está a la vista |
| `21-barra-movil-merma-hecha.png` | Merma de 2 litros de cerveza desde el móvil de la barra |
| `22-recuento-inicio.png` | Empezar un recuento solo de la despensa: el servicio sigue abierto |
| `23-recuento-contando.png` | Cada cantidad se guarda con la hora a la que se contó: aceite 2,3 l y huevos 20 |
| `24-recuento-reconciliacion.png` | La reconciliación descuenta lo vendido mientras se contaba: el aceite sale con −160 ml de diferencia y "salieron 40 ml" (sin la reconciliación saldría −120 ml y el aceite vendido parecería ajuste) |
| `25-recuento-aplicado.png` | Recuento aplicado: ajustes con su valor como movimiento de recuento |
| `26-inventario-avisos.png` | Existencias con avisos de stock bajo: huevos 20 ud frente a un mínimo de 30, sin importes para cocina y barra |
| `27-compras-sugerencia-huevos.png` | La sugerencia de pedido incluye los huevos: cubetas enteras hasta el objetivo |
| `28-escandallos-platos.png` | Escandallos: coste teórico y margen de cada plato con receta |
| `29-escandallos-margen-vendido.png` | Margen vendido: lo que costó de verdad lo ya servido, con el coste de ese momento (anulaciones aparte) |
| `30-movil-en-pausa.png` | En pausa: el tiempo de pausa no cuenta como trabajado |
| `31-movil-de-vuelta.png` | De vuelta de la pausa: vuelve a contar tiempo trabajado |
| `32-cuadrante-comparar-con-fichado.png` | El encargado compara lo planificado con lo fichado: el camarero y la barra entraron a su hora |
| `33-personal-hoy.png` | Personal hoy: quién está dentro, en pausa u olvidado, y los turnos de hoy frente a lo fichado |
| `34-caja-cobro-con-propina.png` | Cobro en efectivo de la mesa (15,00 €) con 2,00 € de propina: la propina entra en la caja para repartirla |
| `35-propinas-con-aviso-olvidado.png` | Propinas por horas: minutos precargados con lo fichado y aviso del fichaje olvidado, que no cuenta hasta cerrarlo |
| `36-horas-cerrar-olvidado.png` | Cerrar un fichaje olvidado: hora de salida explícita y motivo obligatorio, con la previsión de horas |
| `37-horas-olvidado-cerrado.png` | Hoja de horas tras cerrar el olvidado: queda con su historial y sin avisos pendientes |
| `38-propinas-por-horas.png` | Reparto de propinas con las horas fichadas reales de la caja (editables), sin avisos pendientes |
| `39-propinas-repartidas.png` | Reparto confirmado: cada persona con sus minutos y su importe; se guarda una sola vez por caja |
| `40-movil-confirmar-salida.png` | La salida pide confirmación para evitar toques por error |
| `41-movil-salida-hecha.png` | Jornada cerrada: horas trabajadas de la semana al día |
| `42-propinas-caja-sin-fichajes.png` | Una caja en la que nadie fichó: la pantalla lo dice y el reparto sigue siendo manual |
| `43-propinas-sin-modulo-personal.png` | Sin el módulo de personal no hay horas fichadas: lo dice y deja el reparto manual como en la fase 3 |
| `44-plan-sala-menu-encargada.png` | Plan sala: el menú de la encargada no enseña nada de personal, inventario, escandallos ni compras |
| `45-plan-sala-cocina-sin-merma.png` | Plan sala: cocina funciona igual pero sin acceso a la merma |
| `46-plan-sala-inventario-apagado.png` | Plan sala: abrir el inventario a mano explica que el módulo no está activo en este plan |
