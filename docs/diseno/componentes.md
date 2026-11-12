# Componentes del panel

Guía para montar pantallas de Llenamos con el diseño elegido **Sala cálida**. Los fundamentos, tamaños, anchos y reglas están en [README.md](README.md); este catálogo explica qué pieza usar y cómo conectarla. Todo se ve funcionando en **`/panel/muestra`** (solo propietario y encargado, sin entrada en el menú).

La interfaz se monta con **bloques y componentes ya hechos de registros compatibles con shadcn**, no a mano. Los `.dc.html` de esta carpeta solo sirven de referencia de marca (colores, letra, logo y tono), no son el objetivo visual.

## Dónde está cada cosa

| Carpeta | Qué hay | ¿Se toca? |
|---|---|---|
| `apps/web/src/components/ui/` | Componentes de los registros tal cual llegan (shadcn, Origin UI) | Lo mínimo. Se reinstalan con `--overwrite` |
| `apps/web/src/components/common/` | Piezas de Llenamos montadas encima de `ui/` (estado de reserva, etiqueta, tabla, cifra…) | Sí, aquí va lo propio |
| `apps/web/src/components/panel/` | Marco del panel: barra lateral (bloque `sidebar-07`), cabecera, paleta y atajos (`command/`), estados de carga | Sí |
| `apps/web/src/components/reservas/` | Lista por franjas, resumen de turno, línea de tiempo, vista partida y presentación de acciones | Sí, sin cambiar las acciones de `lib/reservas/` |
| `apps/web/src/components/sala/` | Plano con sillas, leyenda, ficha de mesa y adaptación de los estados en directo | Sí, solo presentación |
| `apps/web/src/app/globals.css` | Variables del tema (la marca entra solo por aquí) | Sí, con cuidado |

## Origen y licencia de cada pieza

| Pieza | Registro y bloque | Licencia |
|---|---|---|
| `ui/` alert, avatar, badge, breadcrumb, button, calendar, card, checkbox, collapsible, dialog, dropdown-menu, empty, field, input, input-group, item, kbd, label, native-select, popover, select, separator, sheet, sidebar, skeleton, sonner, spinner, switch, table, tabs, textarea, toggle, toggle-group, tooltip | `@shadcn` (estilo `radix-nova`, base Radix, iconos Phosphor) | MIT, shadcn |
| `ui/progress`, `ui/scroll-area` | `@shadcn` (estilo `radix-nova`), añadidos en la propuesta B de diseño | MIT, shadcn |
| `ui/command.tsx` | `@shadcn/command`, estilo `radix-nova`, sobre `cmdk` 1.1.1 (pacocoursey/dip); adaptado de la propuesta A | MIT, shadcn y cmdk |
| `ui/timeline.tsx` | `@originui/timeline` (registro de Origin UI en `coss.com/origin/r`, código en github.com/cosscom/ui, `apps/origin`) | MIT, coss.com (antes Origin UI) |
| `panel/sidebar/*` (barra lateral, selector de restaurante, usuario abajo) | Bloque `@shadcn/sidebar-07` (team-switcher pasa a selector de restaurante) | MIT, shadcn |
| Cabecera del panel en `PanelShell.tsx` | `site-header` del bloque `@shadcn/dashboard-01` | MIT, shadcn |
| `common/stat-card.tsx` | `section-cards` de `@shadcn/dashboard-01`, sin degradado | MIT, shadcn |
| `common/data-table.tsx` | Tabla de `@shadcn/dashboard-01` sobre TanStack Table v9 | MIT, shadcn y TanStack |
| `auth/login-form.tsx` (`/entrar`) | Bloque `@shadcn/login-04` (la imagen pasa a cuentas de demostración) | MIT, shadcn |
| `common/date-picker.tsx` | Patrón date picker de shadcn: Popover y Calendar (react-day-picker 10) | MIT |
| `common/activity-timeline.tsx` | Usa `ui/timeline` de Origin UI | MIT |
| `common/reservation-status.tsx` | Badge de shadcn con el patrón de punto y palabra de los badges de estado de coss (solo como idea, sin copiar código) | MIT |
| `common/segmented-control.tsx` | `@shadcn/toggle-group` | MIT |
| `common/empty-state.tsx`, `notice.tsx`, `form-fields.tsx`, `loading.tsx`, `tag.tsx` | `@shadcn/empty`, `alert`, `field`, `skeleton`, `badge` | MIT |
| `hooks/use-mobile.ts` | Hook de `@shadcn/sidebar`, reescrito con `useSyncExternalStore` (misma API) | MIT |

Piezas propias del servicio, sobre los componentes de arriba:

| Pieza | Origen y uso | Licencia de las bases |
|---|---|---|
| `panel/command/{commands,hotkeys,Keys}` | Propuesta A, restilada: registro de órdenes, paleta, ayuda y atajos; usa `ui/command`, `dialog`, `kbd` | MIT, shadcn y cmdk |
| `reservas/Timeline` | Propuesta A, restilada con capas de B; dibujo propio con HTML y CSS, sobre `ui/tooltip`. No copia código de Kibo ni de otro Gantt | MIT, shadcn (Tooltip) |
| `reservas/ListaDia` | Filas de la propuesta B, extraídas para la vista partida; agrupadas por media hora y con consultas al ancho de su caja | Propia; `Avatar` de shadcn, MIT |
| `reservas/Huesped`, `ResumenTurno` | Propuesta B; iniciales, visitas, etiquetas y origen; resumen de cubiertos, llegadas y próximas reservas en una superficie | Propias sobre shadcn, MIT; etiquetas inspiradas en Origin UI, MIT (sin copiar código) |
| `reservas/VistaPartida` | Interacción de la propuesta C, tema B: `usePartida`, `PlanoReservas`, `BarraReserva`. Rejilla CSS fija, sin separador arrastrable | Propia sobre shadcn, MIT |
| `reservas/ReservationActions` | Presentación de C: comparte los diálogos y botones de las acciones existentes, sin modificar `actionsFor` ni `runStatusAction` | Propia sobre Button, DropdownMenu, Sheet y Dialog de shadcn, MIT |
| `reservas/tono` | Mapa de clases para el color de filas y bloques por estado | Propia |
| `sala/Plano`, `FichaMesa` | Propuesta B: forma y sillas, color con icono y palabra, encuadre, selección de varias mesas, texto adaptado al ancho | Propias sobre shadcn; entrada de ficha con Motion, MIT |
| `sala/plano-live` | Adaptador de presentación de `TableLive` a los textos y estados del plano | Propia |
| `muestra/MuestraServicio` | Muestrario interactivo con datos inventados y acciones que solo enseñan un aviso | Usa las mismas piezas del servicio |
| `common/customer-badges` | Etiquetas de la ficha del cliente: alergias, habitual, etiquetas propias, idioma y notas. Reutiliza `GuestBadgeChip` de `reservas/Huesped` sin fabricar una reserva | Propia sobre las piezas existentes de shadcn y Phosphor, MIT |
| `common/summary-strip` | Cifras relacionadas dentro de una sola `superficie`, con separadores. Dos columnas en móvil; llevan etiqueta accesible, ayuda y tono opcional | Propia, sin dependencias nuevas |

**Única dependencia nueva del diseño final: `cmdk` (`^1.1.1`, MIT).** No se incorpora `react-resizable-panels`: la rejilla da a la lista y al plano un ancho estable. `progress` y `scroll-area` usan el `radix-ui` existente; Motion y Phosphor ya eran dependencias.

Lo que no se ha usado y por qué:

- **21st** (`https://21st.dev/r/...`): responde 403 «Authentication required». Siguiendo la regla, se va al repositorio del autor (Origin UI en coss.com). No se usa 21st Magic ni nada de pago.
- **coss ui** (`@coss`, Base UI): sus piezas dependen de primitivas propias que sobrescribirían `ui/` y usan lucide. Queda en `components.json` por si se quiere probar en otra rama.
- **Tremor y Kibo UI**: el servicio dibuja sus llegadas y su línea de tiempo con HTML y CSS. El Gantt de Kibo añadiría dependencias innecesarias para este caso.

## Cómo instalar más

Desde `apps/web` (el MCP de shadcn se lanza desde la raíz del repositorio y no ve este `components.json`, así que se usa la línea de órdenes):

```sh
cd apps/web
pnpm dlx shadcn@latest search @shadcn -q "chart"
pnpm dlx shadcn@latest view @originui/timeline
pnpm dlx shadcn@latest add @shadcn/chart
pnpm dlx shadcn@latest add @originui/<nombre>
```

Reglas al instalar:

1. Lo que entra en `ui/` se deja como llega. Si hay que cambiar algo (un texto oculto en inglés, el alto táctil), cambio mínimo y comentado.
2. Si pide `lucide-react`, se cambian los iconos por Phosphor (`@phosphor-icons/react`) antes de guardar.
3. Si un registro pide cuenta o falla, se busca el repositorio original del autor, se mira la licencia (MIT o parecida) y se apunta en la tabla de arriba.
4. Nada de bibliotecas de efectos para páginas de venta (Magic UI, Aceternity y parecidas).

## Tema: variables y clases

La marca entra solo por las variables de shadcn en `globals.css` (`:root` y `.dark`). Solo hay modo oscuro.

| Variable | Valor | Clase | Para qué |
|---|---|---|---|
| `--background` | `#131209` | `bg-background` | Fondo de página |
| `--sidebar` | `#161512` | `bg-sidebar` | Barra lateral |
| `--surface-sunken` | `#0f0e0a` | `bg-surface-sunken` | Plano, carriles y fondos hundidos |
| `--surface-raised` | `#211e18` | `bg-surface-raised` | Opción o fila elegida |
| `--card` | `#1b1914` | `bg-card` | Bloques cálidos |
| `--popover`, `--muted`, `--secondary` | `#24211b` | `bg-popover`, `bg-muted` | Ventanas, paneles, paleta |
| `--accent` | `#2c2820` | `bg-accent` | Opción de menú al pasar |
| `--foreground` | `#f4f1ea` | `text-foreground` | Texto |
| `--soft-foreground` | `#d6d2c8` | `text-soft-foreground` | Texto secundario legible |
| `--muted-foreground` | `#a39f95` | `text-muted-foreground` | Texto apagado (cumple 4,5:1) |
| `--ash` | `#5f5b53` | `bg-ash` | Solo puntos y adornos, nunca texto |
| `--primary`, `--ring`, `--warning` | `#f0a35e` | `bg-primary`, `text-warning` | Acción principal, foco, retraso |
| `--success` | `#8fc7a0` | `text-success`, `bg-success` | Sentada, guardado |
| `--destructive` | `#e8857a` | `text-destructive` | Alergia, cancelar, error |
| `--border`, `--input` | blanco cálido al 7 % y 12 % | `border`, `border-input` | Bordes finos junto a sombras suaves |
| `--radius` | 8 px | `rounded-lg` (8), `rounded-md` (6), `rounded-xl` (10) | Radios |

Clases propias:

- `superficie`: bloque con `bg-card`, borde fino, radio de 14 px (12 en móvil) y `shadow-soft`. Es la caja habitual de una pantalla.
- `shadow-soft`: filo claro y sombra corta con caída difusa. Botones principales, bloques, mesas y opción elegida.
- `shadow-float`: paneles, paleta y selección levantada 1 px.
- `cifra`: Geist Mono con cifras tabulares. Para horas, mesas, personas, importes, referencias y teclas.
- `pointer-coarse:…`: en pantallas táctiles los botones ya miden 44 px como mínimo. Para otros controles, `pointer-coarse:h-11`.
- El foco visible es global (contorno ámbar de 2 px) y los componentes de shadcn ponen su propio anillo.

No se usan sombras grandes, degradados, brillos ni cristal. Sustituye la sombra de un registro por `shadow-soft` o `shadow-float` según la capa. Las ventanas oscurecen el fondo sin desenfoque.

## Qué usar para qué

### Botón: `ui/button`

Un solo botón ámbar (`default`) por pantalla: lo que toca hacer ahora. El resto `outline` o `ghost`. `destructive` para cancelar o desactivar. Alto: `lg` (36) en el panel y `className="h-12"` (48) en acciones de mostrador y en la página pública. `ReservationActionButtons size="xl"` pone esos 48 px. En táctil, los demás controles tienen al menos 44 px.

```tsx
<Button size="lg">Sentar en S7</Button>
<Button size="lg" variant="outline">Cambiar mesa</Button>
<Button size="icon" variant="ghost" aria-label="Más acciones"><DotsThreeIcon /></Button>
```

Botón ocupado: el `Spinner` dentro de un botón no se anuncia (el texto ya cambia).

```tsx
<Button disabled={busy}>
  {busy ? <Spinner role="presentation" aria-label={undefined} aria-hidden /> : null}
  {busy ? "Guardando…" : "Guardar cambios"}
</Button>
```

### Campos: `common/form-fields`

`TextField`, `TextareaField` y `SelectField` llevan etiqueta, ayuda y error enlazados (`aria-describedby`, `aria-invalid`). Para casillas e interruptores, `Field orientation="horizontal"` de `ui/field` con `Checkbox` o `Switch`. Para una lista con buscador o estilo propio, `ui/select`.

```tsx
<TextField label="Teléfono" value={tel} onChange={…} error={errorTel} />
<SelectField label="Rol" value={rol} onChange={…}>
  <option value="waiter">Camarero</option>
</SelectField>
```

Buscador: `InputGroup` con `InputGroupAddon` (icono) e `InputGroupInput`.

### Elegir entre pocas opciones: `common/segmented-control`

Para el turno (Comida, Cena, Todo el día), la zona del plano o la vista. Nunca se queda sin opción elegida. La opción activa lleva capa alzada y sombra suave. Cada opción admite `icon` (Phosphor, oculto al lector) y `short` (texto corto en móvil, manteniendo el nombre completo accesible).

```tsx
<SegmentedControl label="Turno" value={turno} onValueChange={setTurno}
  options={[{ value: "comida", label: "Comida" }, { value: "cena", label: "Cena" }, { value: "dia", label: "Todo el día" }]} />
```

### Pestañas con contador: `ui/tabs`

```tsx
<TabsTrigger value="llegar">Por llegar <span className="cifra text-xs text-muted-foreground">{n}</span></TabsTrigger>
```

`TabsList variant="line"` para pestañas dentro de un detalle.

### Estado de reserva: `common/reservation-status`

Punto y palabra, nunca solo color. `ESTADO_DE_STATUS` traduce el `ReservationStatus` de `@llenamos/core`; `estadoVisible()` decide si una confirmada va «por llegar» o con «retraso N min».

```tsx
const { estado, label } = estadoVisible(r.status, r.startAt, Date.now())
<StatusDot estado={estado} label={label} />
<StatusPill estado="sentada" />
```

Estados: por llegar, retraso, sentada, terminada, cancelada, no se presentó, pendiente, confirmada.

### Etiqueta: `common/tag`

`alergia` (rojo suave), `habitual` (verde suave), `aviso` (ámbar) y `neutro`. Para roles o «Hoy», `ui/badge` con `variant="outline"`.

```tsx
<Tag tone="alergia">Alergia a frutos secos</Tag>
```

### Cifras: `common/stat-card`

En las pantallas de servicio, una sola `superficie` con zonas separadas por `border-l` (como `ResumenTurno`), no varias tarjetas iguales. `StatGrid` y `StatCard` siguen disponibles para cifras administrativas independientes. Solo cifras reales: si un dato aún no existe, no se pone.

```tsx
<StatGrid>
  <StatCard label="Plazas" value={58} hint="en las mesas activas" />
</StatGrid>
```

### Tabla: `common/data-table`

En Clientes se conserva la tabla ordenable en escritorio y se muestran filas táctiles con avatar en móvil. La ficha comparte `GuestAvatar` y `CustomerBadges` con la agenda. `CustomerBadges` recibe `allergies`, `tags`, `visits`, `language` y `notes` de la ficha; no lee ni escribe datos. Ejemplo en `/panel/muestra#m-clientes`.

Para cifras relacionadas fuera del servicio usa `SummaryStrip`: `items={[{ label: "Esperando", value: 4, hint: "12 comensales", tone: "warning" }]}` y `label="Resumen de la lista de espera"`. `tone` admite `success`, `warning` y `destructive`; no añade significado que no diga la etiqueta. Se muestra en Clientes, Lista de espera, Importar y en la muestra.

Para listas administrativas largas (clientes, miembros, mesas del editor). En el servicio usa filas ricas como `ShiftList`, agrupadas por media hora, con `@container/lista` para que se adapten a su caja. Ordena por cabecera, las filas se abren con clic o Intro y se pagina sola a partir de 25. En el móvil se desplaza dentro de su caja.

```tsx
const col = dataTableColumns<Mesa>()
const columns = [
  col.accessor("name", { header: ({ column }) => <DataTableColumnHeader column={column} title="Mesa" /> }),
  col.accessor("capacity", { header: "Plazas", cell: (c) => <span className="cifra">{c.getValue()}</span> }),
]
<DataTable columns={columns} data={mesas} getRowId={(m) => m.id} caption="Mesas de la sala"
  onRowClick={abrir} rowLabel={(m) => `Abrir ${m.name}`} empty="Aún no hay mesas." />
```

### Detalle: `ui/sheet` a la derecha; confirmar: `ui/dialog`

El detalle de una reserva va en `Sheet` a la derecha, a pantalla completa en móvil, con su acción principal abajo. Fondo `bg-popover`, radio grande y `shadow-float`. `Dialog` solo para confirmar algo que no se deshace o para formularios cortos (invitar).

### Menús y ayudas

`DropdownMenu` para «más acciones» (el destructivo con `variant="destructive"` y al final). `Tooltip` solo para botones de solo icono. `Popover` para un dato que se consulta y se cierra. Avisos pasajeros con `toast` de sonner (`toast.success`, `toast.error`); los avisos que deben quedarse, con `Notice`.

### Fechas: `common/date-picker`

```tsx
<DatePicker value={dia} onChange={setDia} label="Día de la reserva" />
```

En castellano, la semana empieza el lunes. `formatoDia(date)` da «lunes 9 de noviembre». `shortOnMobile` pone «lun 9 nov» y esconde el icono en móvil. Úsalo junto a un selector de turno con `short: "Todo"` para que día y turno quepan a 390 px.

Para formularios que guardan un día como `AAAA-MM-DD`, usa `DateInput` del mismo archivo:

```tsx
<DateInput value={fecha} onChange={setFecha} label="Fecha del día especial nuevo" min={hoy} />
<TimeSelectField label="Hora" value={hora} onChange={setHora} error={errorHora} />
```

`DateInput` adapta el día de calendario local sin convertirlo a UTC y enseña también el año. `min` desactiva los días
anteriores; sin `min` permite editar también fechas pasadas. «Borrar fecha» devuelve texto vacío
para conservar la validación del formulario; `clearable={false}` lo oculta en vistas que siempre
necesitan un día. Admite `id`, `aria-invalid` y `aria-describedby`. El calendario del panel usa
casillas de 44 px en dispositivos táctiles y se cierra al ocultarse la página.

`common/time-select-field` compone el `SelectField` y el desplegable existentes: ofrece de
00:00 a 23:45 cada 15 minutos y conserva la hora actual si cae entre dos opciones. Se usa al
registrar una entrada en el momento, también fuera de turno. La validación y las propuestas de
mesa siguen en las funciones existentes. Ambas adaptaciones son propias sobre shadcn, Radix
y react-day-picker (MIT), sin dependencias nuevas. Ejemplos en `/panel/muestra#m-fechas`.

En la web pública, `OtraFecha` tiene casillas de 48 px. Los `SelectField` de personas y lista
de espera llevan `touchSize={48}`: el botón y las opciones conservan ese mínimo incluso en el
portal del menú. El valor predeterminado de `Desplegable` sigue siendo 44 px en táctil para el
panel. No uses controles nativos de fecha, hora ni selección en las pantallas del producto.

### Vacío, carga y avisos

- `EmptyState`: icono, qué pasa y qué hacer («Aún no hay reservas para hoy»).
- `LoadingBlock` con `Skeleton` dentro: la carga se anuncia con texto a los lectores de pantalla.
- `Notice`: `error` (se anuncia al momento), `warning`, `success`, `info`.
- `LiveIndicator`: «En directo» junto al título cuando la página escucha cambios en tiempo real.

### Actividad: `common/activity-timeline`

Línea de tiempo de Origin UI con quién, qué y cuándo («hace 4 min»).

## Cómo montar una página nueva

1. Crea `app/(personal)/panel/<seccion>/page.tsx` con `export const instant = false` y una vista `"use client"`.
2. Envuelve la vista en `RequirePermission` con el permiso de `@llenamos/core`.
3. Estructura (títulos de 24/32 px, una superficie, filas y una acción principal). Para el código de cabecera completo y los anchos, consulta [README.md](README.md#cómo-es-una-pantalla):

```tsx
<>
  <header className="mb-5 flex flex-wrap items-end justify-between gap-3 sm:mb-6">
    <h1 className="text-[24px] font-semibold tracking-tight text-balance sm:text-[32px]">12 clientes nuevos esta semana</h1>
    <Button size="lg" className="shadow-soft max-sm:w-full">Nuevo cliente</Button>
  </header>
  <section className="superficie overflow-hidden">
    <h2 className="border-b px-5 py-3 text-base font-semibold">Clientes</h2>
    <DataTable … />
  </section>
</>
```

4. Añade la entrada en `PANEL_NAV` (`lib/panel/nav.ts`, con su grupo) y su icono en `ICONS` de `panel/sidebar/app-sidebar.tsx`.
5. Si la sección tiene un contador en el menú, devuélvelo en `usePanelNavCounts` (`lib/panel/nav-counts.ts`). Solo cifras reales; si no hay, nada.
6. Títulos que cuentan algo, castellano llano, sin guiones dentro de las frases y sin mayúsculas en cada palabra.

## Piezas del servicio

### Línea de tiempo: `reservas/Timeline`

Recibe `groups` (`groupByShift`), `config`, `day`, `now`, `areas`, `tables`, `tableNames`, `matches`, `selectedId` y `onOpen`. No escribe datos. Una fila por mesa, zonas separadas, reservas sin mesa en carriles que no se pisan y llegadas por media hora arriba. `onOpen` abre el `ReservationDetail` existente. Los filtros apagan bloques sin quitarlos de su sitio. Los carriles contemplan también las mesas que siguen sentadas fuera de su hora. Las filas de 48 px admiten los bloques táctiles de al menos 44 px sin que se tapen.

Usa instantes y la zona del restaurante para las horas; no calcules el día con la zona del navegador. «Ahora» es ámbar, los estados tienen barra y nombre accesible, y una leyenda con palabras. El desplazamiento horizontal queda dentro del bloque. La preferencia lista/tiempo se guarda con `useStoredValue` bajo `llenamos:reservas:vista:<uid>`.

### Lista y plano: `reservas/VistaPartida`

- `useIsSplit()` activa la vista partida desde 1024 px. Debajo, lista sola y opciones Lista, Plano y Tiempo.
- `usePartida({ split, reservations, byTable, onOpenDetail })` centraliza la selección. `selectRow` elige al primer toque y abre al segundo; `selectTable` elige la reserva actual de la mesa y trae su fila a la vista. En móvil ambos abren el detalle.
- `ShiftList` recibe `selectedId` y `onOpen={partida.selectRow}` dentro de `@container/lista`. Elige varias mesas cuando están unidas.
- `PlanoReservas` recibe `selectedTableIds={partida.selected?.tableIds ?? []}` y `onSelectTable={partida.selectTable}`. Cambia a la zona de la selección; permite elegir otra zona a mano hasta que cambie la selección.
- `BarraReserva` se pasa como `footer` del plano. Recibe la reserva, el reloj, la zona horaria, los nombres y la API de acciones. Sus botones miden 48 px. Con `no_show`, el botón dice «Llegó tarde: sentar».

Rejilla: `grid-cols-[minmax(0,1fr)_minmax(0,1.12fr)]`, hueco 24 px. Plano en un `aside` con `sticky top-[calc(var(--header-height)+1rem)]`. En la tableta de 1180 px la barra lateral empieza plegada a iconos.

### Acciones: `reservas/ReservationActions`

Una instancia de `useReservationActions({ reservations, config, tables, tableNames })` por pantalla. Pasa su API a `BarraReserva` o `ReservationActionButtons`; coloca `api.dialogs` una sola vez al final de la pantalla. Enseña `api.error` con `Notice`. Botones y menús consultan el mismo `actionsFor`; las escrituras siguen en `runStatusAction` y las funciones existentes.

Cancelar y no presentado conservan el diálogo de confirmación, cambiar mesa abre `TablesDialog` y mover abre `MoveDialog`. No copies reglas de negocio al plano ni a una fila. El detalle conserva sus acciones de siempre.

### Plano: `sala/Plano`

`tables`, `names` y `label` dibujan una zona; `live` y `onSelect` habilitan el directo. `selectedId` resalta una mesa y `selectedIds` varias. `compact` permite encoger dentro de la columna, sin el ancho mínimo del plano de Sala. `planoLiveMap(byTable, tz)` adapta `TableLive` sin cambiar la lógica.

`ESTADO_MESA` define para cada estado su color, icono, palabra y palabra corta. En mesas pequeñas se esconde primero el cliente, después el icono, y se acorta el estado. Siempre quedan nombre y palabra. Las redondas llevan el contenido centrado con margen horizontal del 10 % y vertical del 16 %, recortado con puntos suspensivos. La leyenda repite icono y palabra. Usa `FichaMesa` para el detalle de Sala y conserva el acceso al detalle completo.

## Paleta y atajos

`PanelCommands` envuelve el panel dentro de `SidebarProvider`. Aporta las secciones permitidas por rol y módulos, cambio de local, menú, salir y ayuda. Para añadir órdenes de una pantalla:

```tsx
const groups = useMemo<PanelCommandGroup[]>(() => [{
  id: "clientes-acciones",
  heading: "Clientes",
  commands: [{ id: "nuevo", label: "Nuevo cliente", shortcut: ["n"], onSelect: () => setCreating(true) }],
}], [])
useRegisterCommands("clientes", groups)
useHotkeys({ n: () => setCreating(true) })
```

Memoriza los grupos con todas las dependencias de sus callbacks. `shortcut` solo dibuja la tecla; `useHotkeys` la escucha. El registro se elimina al ocultarse la página. `useCommandPalette().open()` abre la paleta y `.help()` la lista. `Keys` dibuja `mod` como Ctrl o ⌘ y admite `then` para secuencias.

Las teclas sueltas se desactivan en input, textarea, select, contenido editable o con diálogo, panel o menú abiertos. Ctrl/⌘ K sigue disponible. El resto de combinaciones con modificador debe comprobar el contexto si lanza una acción. Respeta la tabla completa en [README.md](README.md#teclado), `GO_KEYS` y los atajos propios de Reservas. La flecha horizontal dentro de la línea de tiempo debe desplazarla sin cambiar de día.

La paleta usa el fondo flotante, radio 14 y `shadow-float`; `filterCommands` busca sin acentos y permite teléfono con espacios. No incorpores acciones que el rol o los módulos no permitan.

## Next oculta las páginas, no las desmonta

Con `cacheComponents`, Next guarda las páginas en `<Activity>` al navegar. Un menú, diálogo o panel que se queda abierto volvería abierto. Por eso todo lo pasajero se cierra al ocultarse:

```tsx
const [open, setOpen] = useState(false)
useCloseOnHide(() => setOpen(false))   // de @/lib/open-state
<DropdownMenu open={open} onOpenChange={setOpen}>…</DropdownMenu>
```

Los menús sin estado controlado dentro de páginas que no se ocultan (la propia muestra) no lo necesitan.

## Accesibilidad que ya viene hecha

- Foco visible en todo. Contraste de 4,5:1 en texto (el ceniza nunca va en texto).
- 44 px mínimos en pantallas táctiles.
- Etiquetas enlazadas en todos los campos; errores con `role="alert"`.
- Ordenar en las tablas se anuncia con `aria-sort`.
- Los textos ocultos de shadcn están en castellano («Cerrar», «Abrir o cerrar el menú»).

## Configuración: secciones

- `common/settings-section`: `id`, `title`, `description`, `action` y `children`. Una `superficie` con cabecera separada por borde, relleno 16/20 px y campos agrupados. Admite un selector en la cabecera que baja de línea en móvil. Se usa en Horarios y Compartir.

Es una composición propia de Llenamos, sin dependencia ni recurso externo nuevo, y están en `/panel/muestra`. El editor reutiliza `chairSpots` de `sala/Plano` para dibujar las mismas sillas; conserva el encuadre completo 0 a 100 para poder colocar mesas en cualquier punto. En móvil el plano se desplaza dentro de su caja: el suelo permite deslizar y las mesas capturan el dedo al arrastrar.

## Cabecera y resumen del panel general

`common/page-heading.tsx` (`PageHeading`) aplica el titular de 24/32 px, contexto superior, explicación opcional y acciones adaptables al móvil. Props: `title`, `eyebrow`, `description`, `actions`. Se usa en todo el panel (Z1, plano, horarios y compartir); el antiguo `panel/PageHeader` sigue disponible para las zonas pendientes.

`common/summary-strip.tsx` (`SummaryStrip`) reúne cifras relacionadas en una sola `superficie`, dos columnas en móvil y divisiones verticales desde `sm`. Recibe `label` accesible e `items` con `label`, `value` y, opcionales, `hint`, `loading` y `tone` (`success`, `warning`, `destructive`). La carga utiliza `ui/skeleton`. No obtiene datos ni escribe. Ambas piezas son propias, con `Skeleton` de shadcn (MIT), sin dependencias nuevas. Ejemplo en `/panel/muestra`, sección «Cabecera y resumen del panel general».

Mensajes usa filas adaptadas al ancho de su caja, estado con punto y palabra y detalle en `Sheet`. Conserva filtros, orden por fecha o cliente y paginación de 50 mensajes. LogiQD mantiene la tabla administrativa en escritorio y presenta cada restaurante como fila con módulos y acción en móvil.

## Web pública de reservas

`publica/PublicShell` aplica las mismas capas del panel a `/r/[slug]` y `/widget/[slug]`.
En escritorio, personas y día van a la izquierda y las horas a la derecha; en el móvil,
una columna con 16 px de margen. Cada sección usa `superficie`, sin tarjetas anidadas.
Los controles y campos miden 48 px y los radios 12 px. La selección usa capa alzada,
borde y texto de marca; el único botón principal lleva el fondo de marca.

`brandStyle(brandColor)` da el acento, la tinta que contrasta sobre él y el tono legible
sobre fondo oscuro. El calendario y el diálogo reciben esas variables también en sus portales.
Los idiomas y los estados siguen en sus diccionarios de castellano, catalán e inglés.
Los tamaños particulares se limitan con `publica.module.css`, sin modificar el panel.

### Datos de una ficha: `common/summary-list`

Pieza propia de Llenamos, extraída de la ficha pública existente, sin dependencias nuevas.
Lista semántica `dl`, con dos columnas, separadores, cifras tabulares y ajuste de textos largos.
`items` recibe `{ label, value, mono?, wide? }`. `wide` ocupa las dos columnas, por ejemplo
para el estado con punto y palabra. No añade superficie: se coloca dentro de una `superficie`.
Ejemplo visible en `/panel/muestra`, «Ficha de una reserva pública».
