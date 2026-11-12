> **Integrado** (rama `fase6/integracion`): exportaciones de `crearCopiaSeguridad`, `simularRestauracion`, `verContinuidad` y `copiasProgramadas`; `localOnly()` ya no depende de los puertos de la fila 1.

# Integración de continuidad

```ts
export { crearCopiaSeguridad, simularRestauracion, verContinuidad } from './fase6-backup'
export { copiasProgramadas } from './fase6-backup/process'
```

Mantener denegación SDK para backups, backupRequests, restoreDrills, backupHealth y `restoreSandbox/**`; en Storage para `platform/**` y `restore-drills/**`. Las callables de continuidad exigen propietario activo del restaurante con acceso a todos sus locales y deniegan el claim `logiqd`. LogiQD no puede consultar estas operaciones ni explorar su contenido.

Sin índices compuestos nuevos. El estado de continuidad se devuelve sin archivos, claves o destinos. Navegación del panel LogiQD: el coordinador puede consumir `verContinuidad` desde su fila; no hay nueva entrada de restaurante para descargar copias.

Custodia de archivos configurable: `PLATFORM_CUSTODY_ENABLED=1`, `GCLOUD_PROJECT` real, `PLATFORM_DATA_BUCKET` igual al bucket Firebase de ese proyecto (`.appspot.com` o `.firebasestorage.app`) y secreto `PLATFORM_DATA_KEY_V1`, base64 canónico de 32 bytes. Fuera de demo se rechazan variables de emuladores. Las funciones que leen/cifran archivos enlazan el secreto de Secret Manager.

**La captura productiva permanece bloqueada de forma explícita.** La doble lectura local detecta cambios pero no es una barrera de escritores ni acredita coherencia de Firestore y Storage bajo carga. Hasta integrar una ventana de mantenimiento que abarque clientes, callables, disparadores y jobs, usar copias gestionadas y su procedimiento de recuperación verificado. No eliminar esta guardia para publicar. La privacidad puede usar la custodia real configurada, pero esto no constituye una validación de sus plazos legales.
