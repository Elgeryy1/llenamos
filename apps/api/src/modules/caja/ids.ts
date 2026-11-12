/** UUID estable a partir de un hash: repetir la operación no encola un segundo trabajo. */
export const uuidFrom = (hex: string) => `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
