import base from '../../tsup.config'
import { defineConfig } from 'tsup'
export default defineConfig({ ...base, entry: { index: 'src/fase3-print/local-entry.ts' } })
