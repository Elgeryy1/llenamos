import { AuthProvider } from "@/lib/auth/AuthProvider"

/** Zona del personal (entrar y panel): aquí vive la sesión de Firebase Auth. */
export default function PersonalLayout({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>
}
