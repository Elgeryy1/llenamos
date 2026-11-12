import type { NextConfig } from "next"
import path from "node:path"

const nextConfig: NextConfig = {
  output: "standalone",
  // Solo la comprobación del bundle (`scripts/check-bundle.mjs`) cambia la carpeta para no pisar `.next`.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  outputFileTracingRoot: path.resolve(process.cwd(), "../.."),
  cacheComponents: true,
  async headers() { return [
    ...["/p/:path*", "/recibo/:path*", "/aceptar-invitacion", "/m/:path*", "/baja/:path*", "/r/:slug/reserva/:ref", "/r/:slug/lista-espera/:id"].map(source => ({ source, headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "no-store" },
      { key: "X-Robots-Tag", value: "noindex, nofollow" },
    ] })),
    ...["/sw-avisos.js", "/sw-plataforma.js"].map((source) => ({ source, headers: [{ key: "Cache-Control", value: "no-cache, no-store, must-revalidate" }, { key: "Content-Type", value: "application/javascript; charset=utf-8" }] }))] },
  partialPrefetching: true,
  // La lógica compartida se usa directamente desde su código TypeScript.
  transpilePackages: ["@llenamos/core"],
  // Para abrir la web en desarrollo desde otro equipo de la red (ver PROMPT-MAESTRO). Vacío por defecto.
  allowedDevOrigins: (process.env.LLENAMOS_DEV_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  experimental: {
    // Phosphor exporta más de mil iconos: así solo se cargan los que se usan.
    optimizePackageImports: ["@phosphor-icons/react"],
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
}

export default nextConfig
