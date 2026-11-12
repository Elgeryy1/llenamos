import { Client } from 'pg'

/**
 * Despierta a las suscripciones al instante con LISTEN/NOTIFY. Es solo una pista: la verdad la
 * da la lectura por cursor, así que si la escucha cae, el sondeo sigue entregando los eventos.
 */
export class EventWake {
  private readonly listeners = new Map<string, Set<() => void>>()
  private client: Client | undefined
  private stopped = false
  private retry = 0
  private listening = false
  private timer: NodeJS.Timeout | undefined
  constructor(private readonly connectionString: string | undefined, private readonly log: (entry: object) => void = () => {}) {}
  /** Con la escucha sana basta un sondeo de respaldo espaciado; si cae, se vuelve al sondeo corto. */
  get healthy(): boolean { return this.listening }
  start(): void { if (this.connectionString) void this.connect() }
  subscribe(restaurantId: string, wake: () => void): () => void {
    const set = this.listeners.get(restaurantId) ?? new Set()
    set.add(wake)
    this.listeners.set(restaurantId, set)
    return () => { set.delete(wake); if (!set.size) this.listeners.delete(restaurantId) }
  }
  private async connect(): Promise<void> {
    if (this.stopped) return
    const client = new Client({ connectionString: this.connectionString, application_name: 'llenamos-api-live' })
    this.client = client
    const lost = () => {
      if (this.client !== client) return
      this.client = undefined
      this.listening = false
      client.removeAllListeners()
      client.on('error', () => {})
      void client.end().catch(() => {})
      if (this.stopped) return
      this.retry = Math.min(this.retry + 1, 6)
      this.timer = setTimeout(() => void this.connect(), 500 * 2 ** this.retry)
      this.timer.unref()
    }
    client.on('error', lost)
    client.on('end', lost)
    client.on('notification', message => { for (const wake of this.listeners.get(message.payload ?? '') ?? []) wake() })
    try {
      await client.connect()
      await client.query('LISTEN llenamos_events')
      this.listening = true
      this.retry = 0
      // Tras reconectar pudo perderse algún aviso: todos releen una vez.
      for (const set of this.listeners.values()) for (const wake of set) wake()
    } catch {
      this.log({ level: 'warn', event: 'live_listen_failed' })
      lost()
    }
  }
  async stop(): Promise<void> {
    this.stopped = true
    this.listening = false
    clearTimeout(this.timer)
    const client = this.client
    this.client = undefined
    client?.removeAllListeners()
    client?.on('error', () => {})
    await client?.end().catch(() => {})
  }
}
