"use client"
import Image from "next/image"
import { useEffect, useState } from "react"
import { photoBlob } from "@/lib/carta/photos"
export function Photo({ path, alt }: { path: string; alt: string }) {
  const [src, setSrc] = useState<{ path: string; url: string } | null>(null)
  useEffect(() => {
    let active = true
    let url: string | null = null
    void photoBlob(path)
      .then((blob) => {
        if (active) {
          url = URL.createObjectURL(blob)
          setSrc({ path, url })
        }
      })
      .catch(() => {})
    return () => {
      active = false
      if (url) URL.revokeObjectURL(url)
    }
  }, [path])
  return src?.path === path ? (
    <Image
      unoptimized
      width={640}
      height={360}
      src={src.url}
      alt={alt}
      className="h-36 w-full rounded-lg object-cover"
    />
  ) : (
    <div
      className="flex h-24 items-center justify-center rounded-lg bg-surface-sunken text-xs text-muted-foreground"
      role="img"
      aria-label={alt}
    >
      Foto no disponible
    </div>
  )
}
