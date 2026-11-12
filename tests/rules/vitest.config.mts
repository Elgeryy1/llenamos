import { defineConfig } from 'vitest/config'

// Las suites de reglas comparten el proyecto local y limpian sus datos entre pruebas.
export default defineConfig({ test: { fileParallelism: false } })
