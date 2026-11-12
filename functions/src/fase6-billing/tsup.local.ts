import { defineConfig } from 'tsup'
export default defineConfig({ entry: ['src/fase6-billing/emulator-entry.ts'], outDir: 'lib', format: ['esm'], target: 'node22', platform: 'node', noExternal: ['@llenamos/core', 'zod'] })
