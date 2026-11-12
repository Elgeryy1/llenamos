"use client"

import {
  ArmchairIcon,
  CalendarPlusIcon,
  DotsThreeIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  PhoneIcon,
  TrayIcon,
  XCircleIcon,
} from "@phosphor-icons/react"
import { useState, type ReactNode } from "react"
import { toast } from "sonner"
import { PageHeading } from "@/components/common/page-heading"
import { SummaryStrip } from "@/components/common/summary-strip"
import { ActivityTimeline } from "@/components/common/activity-timeline"
import { CustomerBadges } from "@/components/common/customer-badges"
import { GuestAvatar } from "@/components/reservas/Huesped"
import { DataTable, DataTableColumnHeader, dataTableColumns } from "@/components/common/data-table"
import { TimeSelectField } from "@/components/common/time-select-field"
import { DateInput, DatePicker } from "@/components/common/date-picker"
import { EmptyState } from "@/components/common/empty-state"
import { SelectField, TextareaField, TextField } from "@/components/common/form-fields"
import { LiveIndicator, LoadingBlock } from "@/components/common/loading"
import { SettingsSection } from "@/components/common/settings-section"
import { Notice } from "@/components/common/notice"
import { ESTADOS, StatusDot, StatusPill, type EstadoReserva } from "@/components/common/reservation-status"
import { SegmentedControl } from "@/components/common/segmented-control"
import { StatCard, StatGrid } from "@/components/common/stat-card"
import { SummaryList } from "@/components/common/summary-list"
import { Tag } from "@/components/common/tag"
import { PageHeader } from "@/components/panel/PageHeader"
import { usePanel } from "@/components/panel/PanelContext"
import { NoAccess } from "@/components/panel/PanelStates"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import type { ActivityDoc } from "@/lib/data/parse"
import { useNow } from "@/lib/use-now"
import { MuestraServicio } from "./MuestraServicio"

/*
 * Todo lo que hay en la base de componentes, con sus variantes. Los datos son de ejemplo
 * (Taberna Lumbre inventada) y se dicen como tal: aquí no se lee ni se escribe nada.
 */

function Seccion({ id, title, origin, children }: { id: string; title: string; origin: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-4 border-t pt-6">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={id} className="text-base font-semibold">
          {title}
        </h2>
        <span className="cifra text-xs text-muted-foreground">{origin}</span>
      </div>
      {children}
    </section>
  )
}

function Fila({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-3">{children}</div>
}

const ESTADOS_LISTA = Object.keys(ESTADOS) as EstadoReserva[]

type ClienteEjemplo = { id: string; nombre: string; telefono: string; visitas: number; noVino: number; etiqueta: "alergia" | "habitual" | null }
const CLIENTES: ClienteEjemplo[] = [
  { id: "1", nombre: "Clara Ibáñez", telefono: "+34 612 345 678", visitas: 6, noVino: 0, etiqueta: "alergia" },
  { id: "2", nombre: "Familia Roca", telefono: "+34 699 111 222", visitas: 14, noVino: 0, etiqueta: "habitual" },
  { id: "3", nombre: "Pau Ferrer", telefono: "+34 655 000 321", visitas: 2, noVino: 1, etiqueta: null },
  { id: "4", nombre: "Marc Serra", telefono: "+34 644 987 654", visitas: 1, noVino: 0, etiqueta: null },
]
const col = dataTableColumns<ClienteEjemplo>()
const COLUMNAS = [
  col.accessor("nombre", {
    header: ({ column }) => <DataTableColumnHeader column={column} title="Cliente" />,
    cell: (c) => (
      <span className="flex items-center gap-2">
        <span className="font-medium">{c.getValue()}</span>
        {c.row.original.etiqueta === "alergia" ? <Tag tone="alergia">Alergia</Tag> : null}
        {c.row.original.etiqueta === "habitual" ? <Tag tone="habitual">Habitual</Tag> : null}
      </span>
    ),
  }),
  col.accessor("telefono", { header: "Teléfono", enableSorting: false, cell: (c) => <span className="cifra text-soft-foreground">{c.getValue()}</span> }),
  col.accessor("visitas", { header: ({ column }) => <DataTableColumnHeader column={column} title="Visitas" />, cell: (c) => <span className="cifra">{c.getValue()}</span> }),
  col.accessor("noVino", { header: ({ column }) => <DataTableColumnHeader column={column} title="No vino" />, cell: (c) => <span className="cifra">{c.getValue()}</span> }),
]

const ACTIVIDAD: ActivityDoc[] = [
  { id: "a1", action: "table.updated", summary: "ha cambiado la mesa S4", actorUid: "x", actorName: "Laura Vidal", entity: { type: "table", id: "s4" }, createdAt: new Date(Date.now() - 4 * 60_000) },
  { id: "a2", action: "member.invited", summary: "ha invitado a Nora Costa como barra", actorUid: "y", actorName: "Marta Soler", entity: { type: "member", id: "n" }, createdAt: new Date(Date.now() - 52 * 60_000) },
  { id: "a3", action: "restaurant.updated", summary: "ha cambiado el color de marca", actorUid: "y", actorName: "Marta Soler", entity: { type: "restaurant", id: "r" }, createdAt: new Date(Date.now() - 3 * 3_600_000) },
]

export function MuestraView() {
  const { role } = usePanel()
  if (role !== "owner" && role !== "manager") return <NoAccess what="la muestra de componentes" />
  return <Muestra />
}

function Muestra() {
  const now = useNow()
  const [turno, setTurno] = useState<"comida" | "cena" | "dia">("cena")
  const [dia, setDia] = useState<Date | undefined>(() => new Date())
  const [cal, setCal] = useState<Date | undefined>(() => new Date())
  const [fechaTexto, setFechaTexto] = useState("2026-11-09")
  const [hora, setHora] = useState("13:07")
  const [aviso, setAviso] = useState(true)

  return (
    <>
      <PageHeader
        eyebrow="Página interna · sin entrada en el menú"
        title="Muestra de componentes"
        description="La base de la interfaz de Llenamos. Cómo usar cada pieza: docs/diseno/componentes.md. Los datos de esta página son de ejemplo."
      />

      <div className="flex flex-col gap-10">
        <Seccion id="m-panel-general" title="Cabecera y resumen del panel general" origin="common/page-heading y common/summary-strip · piezas propias sobre el tema cálido">
          <PageHeading eyebrow="Taberna Lumbre · Ejemplo" title="16 mesas listas en Centro" description="Datos inventados para enseñar la cabecera y sus acciones." actions={<Button variant="outline">Abrir sala</Button>} />
          <SummaryStrip label="Resumen de ejemplo" items={[
            { label: "Mesas activas", value: 16, hint: "listas para el servicio" },
            { label: "Plazas", value: 62, hint: "en las mesas activas" },
            { label: "Equipo", value: 6, hint: "personas con acceso" },
          ]} />
        </Seccion>
        <Seccion id="m-servicio" title="Diseño final: capas, paleta, lista o tiempo y vista partida" origin="propuesta B con piezas de A y C">
          <MuestraServicio now={now.getTime()} />
        </Seccion>

        <Seccion id="m-configuracion" title="Cabecera y superficies de configuración" origin="Llenamos · composición propia">
          <PageHeading eyebrow="Centro · Ejemplo" title="7 días para llenar tu sala" description="Cabecera de 24 y 32 px con una explicación corta, como en Plano, Horarios y Compartir." />
          <SettingsSection id="m-ajustes" title="Reservas por la web" description="Superficie cálida con cabecera separada y campos agrupados.">
            <TextField label="Nombre del local" defaultValue="Centro" />
            <p className="flex items-center gap-2 text-sm text-success"><span aria-hidden className="size-2 rounded-full bg-success" />Reservas web abiertas</p>
          </SettingsSection>
        </Seccion>

        <Seccion id="m-clientes" title="Clientes y cifras relacionadas" origin="common/customer-badges · common/summary-strip · reservas/Huesped">
          <SummaryStrip label="Resumen de ejemplo" items={[
            { label: "Clientes", value: 48, hint: "datos de ejemplo" },
            { label: "Habituales", value: 12, tone: "success" },
            { label: "Con alergias", value: 3, tone: "destructive" },
          ]} />
          <div className="superficie mt-4 flex items-start gap-3 p-4">
            <GuestAvatar name="Clara Ibáñez" />
            <div className="flex min-w-0 flex-col gap-2">
              <span className="text-[15px] font-medium">Clara Ibáñez</span>
              <CustomerBadges customer={{ allergies: "Frutos secos", tags: ["habitual", "terraza"], visits: 8, language: "ca", notes: "Prefiere una mesa tranquila" }} />
            </div>
          </div>
        </Seccion>

        <Seccion id="m-resumen-publico" title="Ficha de una reserva pública" origin="common/summary-list · Llenamos">
          <section aria-label="Ejemplo de ficha pública" className="superficie max-w-xl overflow-hidden rounded-2xl">
            <h3 className="px-4 py-4 font-semibold">Tu reserva</h3>
            <SummaryList items={[
              { label: "Día", value: "jueves 12 de noviembre" },
              { label: "Hora", value: "21:00", mono: true },
              { label: "Personas", value: 3, mono: true },
              { label: "Señal", value: "no hace falta" },
              { label: "Estado", value: <StatusDot estado="confirmada" />, wide: true },
            ]} />
          </section>
        </Seccion>

        <Seccion id="m-botones" title="Botones" origin="@shadcn/button">
          <Fila>
            <Button size="lg">Sentar en S7</Button>
            <Button size="lg" variant="outline">Cambiar mesa</Button>
            <Button size="lg" variant="secondary">Secundario</Button>
            <Button size="lg" variant="ghost">Ahora no</Button>
            <Button size="lg" variant="destructive">No se presentó</Button>
            <Button size="lg" variant="link">Ver ficha</Button>
          </Fila>
          <Fila>
            <Button size="sm" variant="outline">sm 28</Button>
            <Button variant="outline">default 32</Button>
            <Button size="lg" variant="outline">lg 36 (panel)</Button>
            <Button size="xl">xl 48 (móvil)</Button>
            <Button size="icon" variant="outline" aria-label="Más acciones">
              <DotsThreeIcon weight="bold" />
            </Button>
            <Button size="lg" disabled>
              Desactivado
            </Button>
          </Fila>
          <p className="text-xs text-muted-foreground">Un solo botón ámbar (default) por pantalla: la acción que toca ahora. En pantallas táctiles ninguno baja de 44 px.</p>
        </Seccion>

        <Seccion id="m-estados" title="Estado de reserva" origin="common/reservation-status (patrón status badge de coss)">
          <Fila>
            {ESTADOS_LISTA.map((e) => (
              <StatusDot key={e} estado={e} />
            ))}
          </Fila>
          <Fila>
            <StatusDot estado="retraso" label="Retraso 12 min" />
            <StatusPill estado="sentada" />
            <StatusPill estado="cancelada" />
          </Fila>
        </Seccion>

        <Seccion id="m-tags" title="Etiquetas e insignias" origin="common/tag · @shadcn/badge">
          <Fila>
            <Tag tone="alergia">Alergia a frutos secos</Tag>
            <Tag tone="habitual">Habitual</Tag>
            <Tag>Señal 30 €</Tag>
            <Tag>Cumpleaños</Tag>
            <Tag tone="aviso">Sin mesa</Tag>
          </Fila>
          <Fila>
            <Badge>default</Badge>
            <Badge variant="secondary">secondary</Badge>
            <Badge variant="outline">Hoy</Badge>
            <Badge variant="outline" className="border-primary/30 text-primary">Encargado</Badge>
            <Badge variant="destructive">destructive</Badge>
            <LiveIndicator time="20:42" />
          </Fila>
        </Seccion>

        <Seccion id="m-cifras" title="Cifras" origin="common/stat-card (section-cards de @shadcn/dashboard-01)">
          <StatGrid>
            <StatCard label="Sentados ahora" value="22" tone="success" hint="en 9 de 16 mesas" />
            <StatCard label="Llegan en la próxima hora" value="18" hint="6 reservas" />
            <StatCard label="Confirmadas" value={<>11<span className="text-base text-muted-foreground"> de 14</span></>} hint="3 sin responder" />
            <StatCard label="Lista de espera" value="2" tone="warning" hint="6 personas" action={<Tag tone="aviso">Avisar</Tag>} />
          </StatGrid>
          <StatGrid>
            <StatCard label="Cargando" value="0" loading />
          </StatGrid>
        </Seccion>

        <Seccion id="m-campos" title="Campos" origin="@shadcn/field, input, textarea, native-select, select, checkbox, switch, label, input-group, kbd">
          <div className="grid gap-6 md:grid-cols-2">
            <div className="flex flex-col gap-4">
              <TextField label="Nombre" placeholder="Clara Ibáñez" />
              <TextField label="Teléfono" defaultValue="612 34" error="Falta algún número: un móvil tiene 9 cifras." />
              <TextareaField label="Notas" hint="Las ve todo el equipo." placeholder="Celíaca. Prefiere terraza." />
              <SelectField label="Origen" defaultValue="phone">
                <option value="phone">Teléfono</option>
                <option value="walk_in">En el local</option>
              </SelectField>
            </div>
            <div className="flex flex-col gap-4">
              <Field>
                <FieldLabel htmlFor="m-zona">Zona (Select)</FieldLabel>
                <Select defaultValue="sala">
                  <SelectTrigger id="m-zona" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sala">Sala</SelectItem>
                    <SelectItem value="terraza">Terraza</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <InputGroup>
                <InputGroupAddon>
                  <MagnifyingGlassIcon aria-hidden />
                </InputGroupAddon>
                <InputGroupInput aria-label="Buscar reserva" placeholder="Nombre, teléfono o referencia" />
                <InputGroupAddon align="inline-end">
                  <Kbd>/</Kbd>
                </InputGroupAddon>
              </InputGroup>
              <Field orientation="horizontal">
                <Checkbox id="m-check" defaultChecked />
                <FieldContent>
                  <FieldLabel htmlFor="m-check">Confirmar sola las reservas de la web</FieldLabel>
                  <FieldDescription>Si no, quedan pendientes.</FieldDescription>
                </FieldContent>
              </Field>
              <Field orientation="horizontal">
                <Switch id="m-switch" checked={aviso} onCheckedChange={setAviso} />
                <Label htmlFor="m-switch">Recordatorio el día antes</Label>
              </Field>
            </div>
          </div>
        </Seccion>

        <Seccion id="m-eleccion" title="Control segmentado y pestañas con contador" origin="common/segmented-control (@shadcn/toggle-group) · @shadcn/tabs">
          <SegmentedControl
            label="Turno"
            value={turno}
            onValueChange={setTurno}
            options={[
              { value: "comida", label: "Comida" },
              { value: "cena", label: "Cena" },
              { value: "dia", label: "Todo el día" },
            ]}
          />
          <Tabs defaultValue="todas">
            <TabsList>
              {[
                ["todas", "Todas", 24],
                ["llegar", "Por llegar", 14],
                ["sentadas", "Sentadas", 9],
                ["canceladas", "Canceladas", 1],
              ].map(([v, l, n]) => (
                <TabsTrigger key={v} value={String(v)}>
                  {l}
                  <span className="cifra text-xs text-muted-foreground">{n}</span>
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="todas" className="pt-2 text-muted-foreground">
              Contenido de la pestaña elegida.
            </TabsContent>
          </Tabs>
          <Tabs defaultValue="a">
            <TabsList variant="line">
              <TabsTrigger value="a">Detalle</TabsTrigger>
              <TabsTrigger value="b">Mensajes</TabsTrigger>
            </TabsList>
          </Tabs>
        </Seccion>

        <Seccion id="m-capas" title="Ventanas, panel lateral, menús y ayudas" origin="@shadcn/dialog, sheet, dropdown-menu, popover, tooltip, sonner">
          <Fila>
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Abrir diálogo</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>¿Cancelar la reserva de Pau Ferrer?</DialogTitle>
                  <DialogDescription>Se le avisará por WhatsApp. La señal no se devuelve sola.</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">Ahora no</Button>
                  </DialogClose>
                  <Button variant="destructive">Cancelar reserva</Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Abrir detalle (Sheet)</Button>
              </SheetTrigger>
              <SheetContent className="data-[side=right]:w-full data-[side=right]:sm:max-w-md">
                <SheetHeader>
                  <div className="flex items-center justify-between gap-2 pr-8">
                    <span className="cifra text-xs text-muted-foreground">Ref. K7Q2MD</span>
                    <StatusPill estado="por_llegar" />
                  </div>
                  <SheetTitle className="text-xl">Clara Ibáñez</SheetTitle>
                  <SheetDescription className="cifra">+34 612 345 678</SheetDescription>
                </SheetHeader>
                <div className="flex flex-col gap-5 px-4">
                  <dl className="grid grid-cols-2 gap-px overflow-hidden rounded-lg border bg-border">
                    {[
                      ["Hora", "20:30"],
                      ["Personas", "3"],
                      ["Mesa", "S7"],
                      ["Duración", "1 h 45"],
                    ].map(([k, v]) => (
                      <div key={k} className="bg-card px-3 py-2.5">
                        <dt className="text-xs text-muted-foreground">{k}</dt>
                        <dd className="cifra mt-0.5">{v}</dd>
                      </div>
                    ))}
                  </dl>
                  <div className="flex flex-wrap gap-1.5">
                    <Tag tone="alergia">Alergia a frutos secos</Tag>
                    <Tag tone="habitual">Habitual</Tag>
                  </div>
                  <p className="text-sm text-soft-foreground">Avisar a cocina al sentarla.</p>
                </div>
                <SheetFooter className="flex-row border-t">
                  <Button size="lg" className="flex-1">
                    <ArmchairIcon aria-hidden data-icon="inline-start" />
                    Sentar en S7
                  </Button>
                  <Button size="lg" variant="outline">
                    Cambiar mesa
                  </Button>
                </SheetFooter>
              </SheetContent>
            </Sheet>

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Menú de acciones</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuLabel>Reserva de Clara</DropdownMenuLabel>
                <DropdownMenuItem>
                  <PencilSimpleIcon /> Editar
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <PhoneIcon /> Llamar
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">
                  <XCircleIcon /> Cancelar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Popover</Button>
              </PopoverTrigger>
              <PopoverContent className="text-sm">S1 queda libre a las 20:50 si Pau no aparece.</PopoverContent>
            </Popover>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="icon" aria-label="Nueva reserva">
                  <CalendarPlusIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Nueva reserva</TooltipContent>
            </Tooltip>

            <Button variant="outline" onClick={() => toast.success("Reserva confirmada", { description: "Clara Ibáñez, 20:30, 3 personas." })}>
              Aviso correcto
            </Button>
            <Button variant="outline" onClick={() => toast.error("No se ha podido sentar", { description: "La mesa S7 ya está ocupada." })}>
              Aviso de error
            </Button>
          </Fila>
        </Seccion>

        <Seccion id="m-fechas" title="Fechas" origin="common/date-picker · @shadcn/calendar (react-day-picker)">
          <Fila>
            <DatePicker value={dia} onChange={setDia} label="Día de la reserva" />
            <DateInput value={fechaTexto} onChange={setFechaTexto} label="Fecha de calendario" />
            <TimeSelectField label="Hora de entrada" value={hora} onChange={setHora} />
          </Fila>
          <Card className="w-fit py-0">
            <Calendar mode="single" selected={cal} onSelect={setCal} weekStartsOn={1} className="rounded-xl" />
          </Card>
        </Seccion>

        <Seccion id="m-tabla" title="Tabla de datos" origin="common/data-table (TanStack Table v9, tabla de @shadcn/dashboard-01)">
          <DataTable caption="Clientes de ejemplo" columns={COLUMNAS} data={CLIENTES} getRowId={(c) => c.id} onRowClick={(c) => toast(c.nombre)} rowLabel={(c) => `Abrir la ficha de ${c.nombre}`} />
        </Seccion>

        <Seccion id="m-listas" title="Tarjetas, filas y línea de tiempo" origin="@shadcn/card, item, avatar, separator · @originui/timeline">
          <div className="grid gap-6 lg:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>Necesita atención</CardTitle>
                <CardDescription>Item de shadcn dentro de una Card.</CardDescription>
                <CardAction>
                  <Button variant="link" size="sm" className="h-auto px-0">
                    Ver todo
                  </Button>
                </CardAction>
              </CardHeader>
              <CardContent>
                <ItemGroup className="gap-2">
                  <Item variant="outline" size="sm">
                    <ItemMedia>
                      <span aria-hidden className="size-2 rounded-full bg-warning" />
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Marc Serra no tiene mesa</ItemTitle>
                      <ItemDescription>21:00 · 2 personas. La mejor opción es S3.</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button size="sm" variant="outline">
                        Asignar S3
                      </Button>
                    </ItemActions>
                  </Item>
                  <Item variant="outline" size="sm">
                    <ItemMedia>
                      <Avatar className="size-8">
                        <AvatarFallback className="bg-muted text-xs font-semibold">LV</AvatarFallback>
                      </Avatar>
                    </ItemMedia>
                    <ItemContent>
                      <ItemTitle>Laura Vidal</ItemTitle>
                      <ItemDescription>Encargada</ItemDescription>
                    </ItemContent>
                  </Item>
                </ItemGroup>
              </CardContent>
              <CardFooter className="text-xs text-muted-foreground">CardFooter</CardFooter>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Actividad</CardTitle>
              </CardHeader>
              <CardContent>
                <ActivityTimeline entries={ACTIVIDAD} now={now} label="Actividad de ejemplo" />
              </CardContent>
            </Card>
          </div>
          <Separator />
        </Seccion>

        <Seccion id="m-estados-vacios" title="Avisos, vacío y carga" origin="common/notice (@shadcn/alert) · common/empty-state (@shadcn/empty) · @shadcn/skeleton">
          <div className="grid gap-3 md:grid-cols-2">
            <Notice tone="error" title="No se ha podido guardar" detail="permission-denied">
              Tu rol no puede cambiar los ajustes.
            </Notice>
            <Notice tone="warning" title="Hay mesas que se pisan en el plano">
              S4 y S5. Revisa sus posiciones.
            </Notice>
            <Notice tone="success">Cambios guardados.</Notice>
            <Notice tone="info">Los mensajes no se envían en modo local: quedan capturados.</Notice>
          </div>
          <EmptyState icon={<TrayIcon />} title="Aún no hay reservas para hoy" description="Cuando entre una por la web o por teléfono, aparecerá aquí al momento." action={<Button variant="outline">Nueva reserva</Button>} />
          <LoadingBlock label="Cargando ejemplo…" className="flex flex-col gap-2">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-4 w-72 max-w-full" />
          </LoadingBlock>
        </Seccion>
      </div>
    </>
  )
}
