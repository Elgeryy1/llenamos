import { describe, expect, it } from 'vitest'
import { memberActivity } from './callableActivity'

describe('Actividad de equipo con autor', () => {
  for (const action of ['invited', 'reactivated', 'roleChanged', 'deactivated'] as const) {
    it(action, () => {
      const data = memberActivity({ uid: 'marta', displayName: 'Marta Soler' }, { uid: 'laura', displayName: 'Laura Vidal' }, action, 'manager')
      expect(data).toMatchObject({ action: `member.${action}`, actorUid: 'marta', actorName: 'Marta Soler', entity: { type: 'member', id: 'laura' } })
      expect(data.summary).toContain('Marta Soler ha ')
      expect(data.summary).toContain('Laura Vidal')
    })
  }
})
