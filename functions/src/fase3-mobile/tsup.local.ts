import { defineConfig } from 'tsup'
export default defineConfig({ entry: { index: 'src/fase3-mobile/local-entry.ts' }, outDir: 'lib', format: ['esm'],
  target: 'node22', platform: 'node', sourcemap: true, clean: true, noExternal: ['@llenamos/core', 'zod'] })
