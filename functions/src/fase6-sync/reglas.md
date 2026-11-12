# Integración de sincronización

No hacen falta índices nuevos: dispositivos, flujos, recibos y resoluciones se buscan por id completo.

Las reglas actuales ya deniegan las colecciones privadas por defecto. Fragmento explícito para el coordinador, dentro de `restaurants/{rid}/locations/{lid}` si desea documentarlo en las reglas:

```text
match /syncDevices/{id} { allow read, write: if false; }
match /syncStreams/{id} { allow read, write: if false; }
match /syncReceipts/{id} { allow read, write: if false; }
match /syncResolutions/{id} { allow read, write: if false; }
```

`orderSubmissions` mantiene su denegación existente. Nunca se habilitan escrituras SDK para hacer funcionar la cola. `fase6-sync.test.ts` comprueba lectura, listado, alta, actualización y borrado denegados incluso al propietario.

No hay entradas de navegación nuevas. Las bandejas están integradas en comandero, cocina, tareas y caja.
