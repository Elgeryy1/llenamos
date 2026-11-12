// Compila la entrada propia sin modificar index.ts ni tsup.config.ts del coordinador.
import { build } from 'tsup'
await build({ entry:{ index:process.argv[2] === 'callables' ? 'src/fase6-privacy/emulator-callables.ts' : 'src/fase6-privacy/emulator-entry.ts' },outDir:'lib',format:['esm'],platform:'node',target:'node22',noExternal:['@llenamos/core','zod'],clean:true,sourcemap:true,config:false })
