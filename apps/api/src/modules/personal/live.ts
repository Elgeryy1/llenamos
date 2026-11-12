import * as core from '@llenamos/core'
import { TABLES, can, deny, listAll, loadStaffSettings } from '../fase4/contexto.js'
import { liveQuery } from '../fase4/operacion.js'
import type { LiveQuery } from '../types.js'

const L = core.PERSONAL_LIVE

/** Fichajes de un periodo: solo los propios con `fichaje.registrar`; los de otros o los de todos, con `personal.gestionar`. */
const fichajes = liveQuery(L.fichajes, 'fichaje.registrar', ['staff'], core.PersonalFichajesInputSchema, core.PersonalFichajesOutputSchema, ['personal.fichaje'],
  async (c, i) => {
    if (i.from > i.to || (Date.parse(i.to) - Date.parse(i.from)) / 86_400_000 > 93) deny('El periodo no es válido (como máximo 93 días).')
    if (i.uid !== c.uid && !can(c, 'personal.gestionar')) deny()
    // Un fichaje que cruza la medianoche cuenta en el día anterior: se mira un día antes.
    const params: unknown[] = [core.sumarDias(i.from, -1), i.to]
    if (i.uid !== null) params.push(i.uid)
    return { entries: await listAll(c, TABLES.entries, core.TimeEntrySchema, `entry_date>=$3 AND entry_date<=$4${i.uid !== null ? ' AND uid=$5' : ''}`, params, 'entry_date,start_at', i.max) }
  })

const abiertos = liveQuery(L.abiertos, 'personal.gestionar', ['staff'], core.PersonalScopeSchema, core.PersonalAbiertosOutputSchema, ['personal.fichaje'],
  async (c) => ({ entries: await listAll(c, TABLES.entries, core.TimeEntrySchema, "status='open'", [], 'start_at,id', 500) }))

/** Turnos de una semana. Quien no gestiona solo ve los publicados. */
const turnos = liveQuery(L.turnos, 'cuadrante.ver', ['staff'], core.PersonalTurnosInputSchema, core.PersonalTurnosOutputSchema, ['personal.turno'],
  async (c, i) => {
    const onlyPublished = i.onlyPublished || !can(c, 'personal.gestionar')
    return { shifts: await listAll(c, TABLES.shifts, core.StaffShiftSchema, `week_start=$3${onlyPublished ? " AND status='published'" : ''}`, [i.weekStart], 'start_at,id', 500) }
  })

const eventos = liveQuery(L.eventos, 'personal.gestionar', ['staff'], core.PersonalEventosInputSchema, core.PersonalEventosOutputSchema, ['personal.fichaje'],
  async (c, i) => ({ events: await listAll(c, TABLES.entryEvents, core.TimeEntryEventSchema, 'entry_id=$3', [i.entryId], 'id', 200) }))

const ajustes = liveQuery(L.ajustes, 'personal.gestionar', ['staff'], core.PersonalScopeSchema, core.PersonalAjustesOutputSchema, ['personal.ajustes'],
  async (c) => ({ settings: await loadStaffSettings(c) }))

export const personalLiveQueries: LiveQuery[] = [fichajes, abiertos, turnos, eventos, ajustes]
