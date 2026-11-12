export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message) }
}
export const unauthorized = () => new ApiError(401, 'unauthenticated', 'Inicia sesión de nuevo.')
