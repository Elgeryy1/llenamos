import { analisisModule } from './analisis/index.js'
import { cajaModule } from './caja/index.js'
import { campanasModule } from './campanas/index.js'
import { fidelizacion } from './fidelizacion/index.js'
import { inventarioModule } from './inventario/index.js'
import { panelModule } from './panel/index.js'
import { personalModule } from './personal/index.js'
import { platformModule } from './plataforma/index.js'
import { proveedoresModule } from './proveedores/index.js'
import { privacyModule } from './privacidad/index.js'
import { reservasModule } from './reservas/index.js'
import { sala } from './sala/index.js'
import { syncModule } from './sync/index.js'
import type { ModuleDefinition } from './types.js'
import { workerModule } from './worker/index.js'

// Una línea por módulo, en orden alfabético, para que las fusiones no choquen.
export const MODULES: readonly ModuleDefinition[] = [
  analisisModule,
  cajaModule,
  campanasModule,
  fidelizacion,
  inventarioModule,
  panelModule,
  personalModule,
  platformModule,
  privacyModule(() => MODULES),
  proveedoresModule,
  reservasModule,
  sala,
  syncModule,
  workerModule,
]
