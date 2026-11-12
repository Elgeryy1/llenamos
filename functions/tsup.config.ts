import { defineConfig } from "tsup"

// Empaqueta las funciones con @llenamos/core dentro, para que el despliegue
// a Firebase no dependa del monorepo.
export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "lib",
  format: ["esm"],
  target: "node22",
  platform: "node",
  sourcemap: true,
  clean: true,
  noExternal: ["@llenamos/core", "zod"],
})
