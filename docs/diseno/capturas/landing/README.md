# Capturas reales en la web de venta

Las tres imágenes de `apps/landing/public/capturas/` son WebP sin pérdida, a la resolución
original 2x. No se han retocado los datos ni recortado las pantallas:

| Imagen | Origen | Dimensiones | Peso |
|---|---|---|---|
| `sala.webp` | `../final/sala.png` | 2880 × 1800 | 173308 bytes |
| `reservas.webp` | `../final/reservas-lista.png` | 2880 × 1800 | 139322 bytes |
| `movil.webp` | `../z4-publica/horas-movil.png` | 780 × 1688 | 54862 bytes |

Los originales se tomaron con Playwright contra los emuladores y datos de Taberna Lumbre,
nuestro restaurante inventado. La lista junto al plano muestra las dos vistas del equipo en
un solo hueco. La vista móvil conserva las personas, el día y la acción de continuar.
Los textos alternativos describen lo que hay en cada imagen y las leyendas dicen «Captura».

Las seis capturas de revisión de esta carpeta son nuevas, de Chromium a 2x: escritorio
1440 × 900 y móvil táctil 390 × 844. Se comprueba que las tres imágenes cargan, que sus
atributos de tamaño coinciden con las dimensiones naturales y que ninguna desborda.
`comprobaciones.json` guarda los resultados. Se respeta la preferencia de movimiento reducido.

Para repetir, desde la raíz del worktree:

```sh
pnpm --filter landing dev --port 5192
# Otra terminal, con Playwright ya instalado:
node docs/diseno/capturas/landing/capturar.cjs
```

Si Playwright está fuera del proyecto, indica su `node_modules` en `NODE_PATH`.
`CHROMIUM_PATH` permite usar el Chromium ya instalado sin descargar nada.
Aquí se usaron `/tmp/carta-tools/node_modules` y
`/home/gery/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome`.
Sin dependencias nuevas. La conversión de los PNG a WebP se hizo con Pillow ya instalado,
`Image.open(origen).save(destino, 'WEBP', lossless=True, method=6)`.
