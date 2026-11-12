import { AuthProvider } from '@/lib/auth/AuthProvider'
import { Alta } from '@/components/alta/Alta'

export const instant = false
export default function AltaPage() { return <AuthProvider><Alta /></AuthProvider> }
