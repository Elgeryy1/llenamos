import type { Metadata } from 'next'
import { Privacidad } from '@/components/privacidad/Privacidad'
export const metadata:Metadata = { title:'Privacidad' }
export const instant = false
export default function Page() { return <Privacidad /> }
