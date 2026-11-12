"use client"

import { Notice } from "@/components/common/notice"
import { describeError } from "@/lib/firebase/errors"

/** Error al leer datos en directo, con el motivo en castellano. */
export function LiveError({ title, error }: { title: string; error: unknown }) {
  const info = describeError(error)
  return (
    <Notice tone="error" title={title} detail={info.code}>
      {info.message}
    </Notice>
  )
}
