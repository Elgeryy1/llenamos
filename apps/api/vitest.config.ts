import { defineConfig } from 'vitest/config'

// Las pruebas de integración crean roles globales de PostgreSQL (CREATE ROLE ... IF NOT EXISTS no es
// atómico entre bases simultáneas), así que los archivos se ejecutan uno tras otro.
export default defineConfig({ test: { fileParallelism: false } })
