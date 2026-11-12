> **Integrado** (rama `fase6/integracion`): estas reglas y el índice ya están en `firebase/`, `rules-patch.ts` se ha retirado y `tests/rules/fase6-billing.test.ts` prueba las reglas comunes. Ver «Integración de la fase 6» en ARQUITECTURA.md.

# Fragmentos para el coordinador

Esta fila no modifica `firebase/**`. `rules-patch.ts` expresa la modificación restrictiva y las cuatro pruebas `tests/rules/fase6-billing.test.ts` cargan el resultado en el emulador, restaurando después las reglas comunes. Esto prueba el fragmento propuesto, no declara que ya esté integrado en Firebase.

1. En `module(rid,name)`, cuando `entitlementVersion > 0`, exigir `accessValidUntil is timestamp`, `request.time < accessValidUntil`, `activeModules is list` y pertenencia explícita del módulo. No aplicar el fallback antiguo a migrados.
2. Añadir `platformService` a lecturas y cambios de plano de restaurantes migrados. Un acceso vencido conserva las vías administrativas por callable; no concede lecturas operativas ilimitadas.
3. Los locales migrados no se crean ni eliminan desde el SDK. Su escritor de servidor debe reservar o liberar el contador con la operación. Los antiguos conservan sus reglas. La edición de identidad del local conserva `updatedBy` y los campos permitidos actuales.
4. Mantener la lista explícita de campos editables del restaurante. Ya impide escribir `entitlementVersion`, `accessValidUntil`, `commercialPlanId`, `commercialPlanVersion`, `moduleOverrides`, `activeModules` y `plan`.
5. No abrir ninguna lectura ni escritura directa de `onboardings`, `onboardingKeys`, `restaurantSlugs`, `platformPlans`, `platformRequests`, `billingEvents`, `platformWorkers`, `restaurants/{rid}/platform/**`, `billingIntents` ni `platformEvents`. Las callables devuelven proyecciones saneadas y vuelven a comprobar membresía y permisos. Tampoco se abre Storage.

Índice de grupo de colección necesario para localizar el contrato guardado al recibir Billing. Datos para incorporar en `firestore.indexes.json`:

```json
{
  "fieldOverrides": [
    {
      "collectionGroup": "platform",
      "fieldPath": "stripeSubscriptionId",
      "indexes": [
        { "order": "ASCENDING", "queryScope": "COLLECTION" },
        { "order": "DESCENDING", "queryScope": "COLLECTION" },
        { "order": "ASCENDING", "queryScope": "COLLECTION_GROUP" }
      ]
    }
  ]
}
```

No hacen falta índices compuestos nuevos en esta fila. El emulador no certifica que los índices productivos estén publicados.
