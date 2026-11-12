import { defineConfig } from 'tsup'
export default defineConfig({ entry: { index: 'src/fase6-api/emulador-entry.ts' }, outDir: 'lib', format: ['esm'], target: 'node22', platform: 'node', sourcemap: true, clean: true, noExternal: ['@llenamos/core', 'zod'] })
