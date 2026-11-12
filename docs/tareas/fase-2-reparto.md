# Fase 2 · Sala y cocina · reparto entre agentes

Objetivo: el restaurante toma pedidos en sala o desde la mesa por QR, cocina y barra los preparan por estación y pases, la sala atiende tareas con dueño y hay para llevar con hora de recogida.

El contrato está en `ARQUITECTURA.md`, sección **«Fase 2 · Sala y cocina»**, y en `packages/core` (carta, sala, cocina). Manda el contrato; core queda congelado y cualquier cambio de firma lo centraliza el coordinador.

## Orden

1. **Backend** (`fase2/backend`, agente 3): empieza ya, en paralelo con la etapa 0, porque no toca la web.
2. Cuando el diseño final (`diseno/final`) esté en `main`: **comandero** (`fase2/comandero`), **cocina** (`fase2/cocina`) y **carta y pedido público** (`fase2/carta-publica`), en paralelo, con el sistema de `docs/diseno/`.
3. Integración (coordinador): backend, carta, comandero y cocina; recorrido reserva → mesa → pedido → estación → recogida → cierre, QR y para llevar, con capturas.

La propiedad de carpetas de cada agente está en la tabla «Reparto de la implementación» del contrato. Puertos, reglas comunes y normas: las de `docs/tareas/etapa-0-reparto.md`.

## Backend · `fase2/backend` · agente 3

Lo que dice su fila del contrato: las 28 callables de `CALLABLE_SCHEMAS` de la fase 2 con sus transacciones y bloqueos, gasto con `spendContributions`, actividad con `changeId`, proyección `publicMenus`, reglas de Firestore y Storage con pruebas a favor y en contra por rol, módulo y local, índices, procesador local de recogidas (`pnpm sala:procesar`), seed idempotente de carta y estaciones (`scripts/seed-fase2.ts`, llamado desde `pnpm seed`) e integración contra emuladores: doble apertura de la misma mesa, precio manipulado por el cliente, token de otra mesa o local, doble dueño de una tarea y reintentos de gasto sin duplicar. Sentar una reserva con `floor` abre la mesa en la misma transacción.

Comprobación: la común, más reglas e integración con su config de emuladores.
