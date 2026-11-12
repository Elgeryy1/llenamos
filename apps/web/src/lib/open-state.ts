"use client"

import { useCallback, useLayoutEffect, useRef, useState } from "react"

/**
 * Con cacheComponents, Next no desmonta la página al navegar: la oculta con <Activity>.
 * Esta función llama a `close` cuando el componente se oculta (o se desmonta), para no
 * encontrar al volver una ventana o un menú abiertos.
 *
 * El cierre se aplaza a una microtarea: en desarrollo, React monta, limpia y vuelve a
 * montar los efectos (StrictMode), y ese ensayo no debe cerrar nada.
 */
export function useCloseOnHide(close: () => void) {
  const closeRef = useRef(close)
  useLayoutEffect(() => {
    closeRef.current = close
  })
  const visible = useRef(false)
  useLayoutEffect(() => {
    visible.current = true
    return () => {
      visible.current = false
      queueMicrotask(() => {
        if (!visible.current) closeRef.current()
      })
    }
  }, [])
}

/**
 * Estado abierto o cerrado de una ventana o menú de Radix, controlado desde fuera
 * (`open` y `onOpenChange`) o por dentro (`defaultOpen`). Se cierra solo al ocultarse.
 */
export function useOpenState(openProp: boolean | undefined, defaultOpen: boolean | undefined, onOpenChange: ((open: boolean) => void) | undefined) {
  const [inner, setInner] = useState(defaultOpen ?? false)
  const controlled = openProp !== undefined
  const open = controlled ? openProp : inner
  const setOpen = useCallback(
    (next: boolean) => {
      if (!controlled) setInner(next)
      onOpenChange?.(next)
    },
    [controlled, onOpenChange],
  )
  useCloseOnHide(() => {
    if (open) setOpen(false)
  })
  return [open, setOpen] as const
}
