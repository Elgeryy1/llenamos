import { defineConfig } from 'tsup'
export default defineConfig({entry:['src/main.ts','src/migrate.ts','src/worker-main.ts'],format:['esm'],target:'node22',outDir:'dist',sourcemap:true,clean:true,noExternal:['@llenamos/core']})
