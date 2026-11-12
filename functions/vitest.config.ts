import { defineConfig } from 'vitest/config'

// Las pruebas de integración comparten los emuladores: en paralelo se pisan los disparadores.
export default defineConfig({ test: { fileParallelism: false } })
