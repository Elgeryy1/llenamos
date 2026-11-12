"use client"
import { useEffect, useState } from 'react'
import { PublicShell } from '@/components/publica/PublicShell'
import { usePublic } from '@/components/publica/PublicContext'
import { Button } from '@/components/ui/button'
import { Notice } from '@/components/common/notice'
import { privatePath } from '@/lib/pago-movil/api'
import { texts } from '@/lib/pago-movil/textos'
export function ReturnApp({ checkoutId }: { checkoutId: string }) {
  const { lang } = usePublic(), t = texts(lang)
  const [path, setPath] = useState<string | null>(null)
  useEffect(() => {
    void Promise.resolve().then(() => {
      try {
        const saved = sessionStorage.getItem(`llenamos:mobile:${checkoutId}`)
        if (saved) setPath(privatePath(saved, '/p/'))
      } catch { /* El personal puede recuperar el enlace si no hay almacenamiento. */ }
    })
  }, [checkoutId])
  return <PublicShell name={null} brandColor={null}><div className="space-y-5"><h1 className="text-2xl font-semibold">{t.returnTitle}</h1><Notice>{t.returnHint}</Notice>{path ? <Button asChild className="min-h-12 w-full"><a href={path}>{t.back}</a></Button> : null}</div></PublicShell>
}
