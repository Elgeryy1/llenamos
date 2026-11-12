> Integrado el 2026-11-10 en `fase5/cierre`: navegación, cliente, caja, backend, reglas y seed conectados. Recorrido actual en [fase5](../../../../../docs/diseno/capturas/fase5/README.md). El resto conserva las instrucciones y comprobaciones de la entrega original.

# Fidelización, promociones y Repite

Entrega de la fila 2, rama `fase5/fidelizacion-web`. No hay cambios en core, backend, reglas, navegación ni pantallas compartidas. Sin dependencias nuevas. Los esquemas y permisos se toman de `CALLABLE_SCHEMAS` y `FASE5_ACCESS`. Todas las escrituras usan callables y `requestId`; nunca escriben Firestore desde el navegador.

## Rutas

| Ruta | Acceso |
| --- | --- |
| `/panel/fidelizacion` | `guardarConfiguracionFidelizacion`: propietario o encargado, `loyalty` |
| `/panel/fidelizacion/promociones` | `guardarPromocion`: propietario o encargado, `loyalty` |
| `/panel/fidelizacion/repite` | `guardarAjustesRepite`: propietario o encargado, `repite` |
| `/panel/fidelizacion/demo` | `verCuentaFidelizacion` o `verTarjetaRepite`, según rol y módulo |

Las tres primeras rutas leen documentos reales. Un error de reglas o de backend se presenta con su motivo. La demo es explícita y usa `lib/fidelizacion/fixtures.ts`: nombres, puntos, cuenta, programa y promociones inventados, sin guardar ni confirmar mutaciones. No hay una sustitución automática por fixtures cuando falla una consulta real. La demo también respeta los módulos y el rol de la sesión.

## Montar FichaFidelizacion

Importación: `@/components/fidelizacion/FichaFidelizacion`.

Lugar: dentro de `components/reservas/CustomerSheet.tsx`, después de los datos y notas del cliente. Es la ficha que usa `panel/clientes/ClientesView.tsx` y también Reservas. Lo integra el coordinador.

| Prop | Tipo y origen |
| --- | --- |
| `restaurantId` | `string`, del restaurante de `usePanel()` |
| `customerId` | `string`, `customer.id` real |
| `customerName` | `string`, `customer.name` |
| `role` | `Role` de la membresía activa del panel |
| `modules` | `readonly Module[]`, `restaurantModules(restaurant)` de core |
| `termsVersion` | `string \| null`, versión leída de `settings/loyalty`; null mientras falte o haya error |
| `termsText` | `string` opcional con las condiciones que presenta el restaurante |
| `locationId` | `string` opcional, local de la visita |
| `reservationId`, `sessionId` | `string \| null` opcionales, de la visita actual. Con alguno y `locationId` aparece el sello a mano |
| `timezone` | `string` opcional; por defecto `Europe/Madrid` |
| `api` | `ApiFidelizacion` opcional, solo para pruebas y la demo. En producción se omite |

```tsx
<FichaFidelizacion
  restaurantId={restaurant.id}
  customerId={customer.id}
  customerName={customer.name}
  role={role}
  modules={restaurantModules(restaurant)}
  termsVersion={settings?.termsVersion ?? null}
  timezone={restaurant.timezone}
  locationId={location?.id}
  reservationId={reservationId ?? null}
  sessionId={sessionId ?? null}
/>
```

La ficha consulta puntos, caducidad, movimientos y tarjeta. El alta exige una casilla inicialmente vacía y la versión de las condiciones; no acepta marketing. Cambiar cliente, permisos o versión reinicia la aceptación. Los puntos solo se ajustan con `fidelizacion.gestionar` y motivo. La tarjeta se consulta al momento; crear o dar sello en cola dice pendiente, y sin conexión dice que falta. Solo una creación confirmada puede ofrecer su enlace HTTPS para guardar en Wallet. El aviso «te echamos de menos» distingue encolado de enviado.

## Montar DescuentosCuenta

Importación: `@/components/fidelizacion/DescuentosCuenta`.

Lugar: en `CuentaLocal` de `components/caja/Cuenta.tsx`, dentro de la rama con `bill` cargada, después de `Consumo` y antes del reparto y el cobro. Lo integra el coordinador. El componente ya incluye su superficie y encabezado.

| Prop | Tipo y origen |
| --- | --- |
| `restaurantId`, `locationId` | `string`, del alcance real de la cuenta |
| `bill` | `Bill & { id: string }` de core; cuenta vigente, con cliente, revisión, estado y ajustes |
| `role`, `modules` | Igual que en la ficha |
| `onBillChanged` | `(revision: number) => void \| Promise<void>`; refrescar la cuenta real o esperar a que `useCuenta` reciba esa revisión |
| `api` | Opcional para pruebas; omitir al integrar |

```tsx
<DescuentosCuenta
  restaurantId={scope.restaurantId}
  locationId={scope.locationId}
  bill={{ ...bill, id: billId }}
  role={role}
  modules={restaurantModules(restaurant)}
  onBillChanged={async () => {
    await llamarCaja("verCuenta", { ...scope, billId })
    // useCuenta recibe la cuenta confirmada del servidor.
  }}
/>
```

El padre mantiene la suscripción real a la cuenta y debe pasar su revisión nueva. Tras una mutación confirmada los botones quedan bloqueados hasta recibirla. No sustituir la cuenta por los totales de una fixture ni sumar el descuento en el cliente.

Las promociones se consultan por cuenta y código. Se muestran también los motivos de las que no valen. El servidor puede rechazar la aplicación aunque la consulta anterior la considerase válida. El canje manda premio, cliente y revisión, nunca un descuento. Un saldo insuficiente no cambia la cuenta. Quitar promoción y anular canje exigen motivo. Los canjes aplicados se obtienen de `bill.adjustments[].redemptionId`; no hace falta pasar otro listado. Una cuenta que no esté abierta deshabilita las operaciones.

El coordinador también tiene que mostrar los ajustes `discount` como «Descuento» en Consumo; esa presentación pertenece a caja y no se ha editado aquí.

## Datos para la navegación

No se ha modificado `lib/panel/nav.ts` ni la barra lateral.

```ts
{
  label: "Fidelización",
  href: "/panel/fidelizacion",
  icon: GiftIcon, // @phosphor-icons/react
  permission: "fidelizacion.gestionar",
  modulesAny: ["loyalty", "repite"],
}
```

Son datos para adaptar al formato del menú común, no una nueva firma de core. La condición es permiso de gestión y `loyalty` o `repite`. Si solo está activo `repite`, dirigir a `/panel/fidelizacion/repite`; la ruta principal también ofrece un enlace a esa opción. Para operar, el camarero accede desde cliente y caja y no necesita una entrada de configuración. Subrutas e iconos disponibles: programa `GiftIcon`, promociones `SealPercentIcon`, Repite `WalletIcon`.

## Probar en local

Usar `firebase.agente2.json` ignorado, copia de `firebase.json` con Auth 9103, Firestore 8097, Functions 5013, Storage 9213, UI 4012, Hub 4412, Logging 4512, Eventarc 9312 y Tasks 9512. Web 3012. Proyecto `demo-llenamos`.

```sh
npx firebase emulators:start --project demo-llenamos --config firebase.agente2.json
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm seed
FIRESTORE_EMULATOR_HOST=127.0.0.1:8097 FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9103 pnpm seed:servicio
```

Arrancar Next con las variables de `.env.example`, los cuatro `NEXT_PUBLIC_*_EMULATOR_PORT` de la fila 2 y `pnpm --filter web exec next dev --port 3012`. Abrir `http://localhost:3012/entrar` y entrar con `propietario@lumbre.test` o `camarero@lumbre.test`, contraseña `Llenamos2026!`.

El seed básico usa plan `sala`: para revisar estas pantallas habilitar **solo en el emulador 8097** el plan `completo` y el módulo opcional `repite`. No cambiar el catálogo comercial. En la revisión se hizo con Admin SDK contra el emulador. El backend de fase 5 y su seed todavía no están integrados en esta rama.

```sh
pnpm --filter web exec vitest run src/lib/fidelizacion src/components/fidelizacion
node apps/web/src/lib/fidelizacion/capturas.mjs
```

El segundo comando recorre las sesiones reales, verifica los rechazos y permisos y genera las capturas con README en `docs/diseno/capturas/fase5-fidelizacion/`. Oculta únicamente la herramienta de desarrollo de Next en las capturas.

En esta máquina el gestor necesitó caché temporal: `PNPM_HOME=/tmp/llenamos-f5-pnpm XDG_DATA_HOME=/tmp/llenamos-f5-data XDG_CACHE_HOME=/tmp/llenamos-f5-cache`. Firebase se arrancó con `XDG_CONFIG_HOME=/tmp/llenamos-f5-config` para usar una configuración local vacía, sin credenciales reales.

## Comprobaciones y pendientes

Lint, tipos, pruebas y build completos del repositorio pasan: core 609 pruebas, web 602 y funciones 117. Las suites normales omiten 3 pruebas de web y 226 de integración de funciones por su configuración; no se presentan como ejecutadas. Las 23 pruebas de esta entrega pasan. Pruebas específicas: permisos, transporte, idempotencia, conservación de franjas nocturnas al editar, rechazo de cupo, saldo insuficiente, revisión de cuenta, anulaciones, alta con condiciones y tarjeta o sello pendientes. Las pruebas de interfaz usan dobles tipados, nunca un éxito simulado en la aplicación.

Navegador con Auth y Firestore reales de la fila 2 y ambos seeds: propietario y camarero; escritorio, tableta y móvil a 2x; sin errores de página ni desbordamientos horizontales.

Pendiente del coordinador: integrar el backend, sus reglas y seed; montar las dos piezas; adaptar menú y etiqueta de descuento; recorrer aplicar, canjear y cobrar con las callables reales. No se ha modificado servidor ni reglas y no se atribuyen pruebas de integración del backend de fase 5 a esta entrega.

Cierre de procesos: se enviaron señales de parada a las sesiones de Next y Firebase. El ejecutor cerró los lanzadores con código 130, pero dejó hijos: los puertos 4412, 9103, 8097, 5013 y 9213 seguían respondiendo y 3012 conservaba un listener sin responder. El aislamiento de PID de cada comando impide localizar y matar esos hijos desde un comando posterior. El coordinador debe cerrarlos desde el host, comprobando que pertenecen a este worktree. No se han señalado procesos de otros agentes.

Mensaje de commit propuesto: `Añade la web de fidelización, promociones y Repite con piezas para cliente y caja`.
