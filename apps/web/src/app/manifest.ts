import type { MetadataRoute } from "next"

export default function manifest(): MetadataRoute.Manifest {
  return { name: "Llenamos", short_name: "Llenamos", description: "El servicio de tu restaurante", start_url: "/panel", scope: "/panel/", display: "standalone", background_color: "#131209", theme_color: "#131209", icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" }] }
}
