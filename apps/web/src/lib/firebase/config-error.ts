/** Error de configuración compartido sin cargar SDK de datos. */
export class FirebaseConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Firebase no está configurado: ${problems.join(" ")}`)
    this.name = "FirebaseConfigError"
  }
}
