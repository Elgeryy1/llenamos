"use client"
import { usePublic } from "@/components/publica/PublicContext"
import { Notice } from "@/components/common/notice"
import { ZodError } from "zod"
import { errorText, ServiceError } from "@/lib/carta/callables"
import { publicText } from "@/lib/mesa-publica/textos"
export function MenuError({ error }: { error: unknown }) {
  const { lang } = usePublic()
  const permission = error instanceof Error && "code" in error && String(error.code).includes("permission-denied")
  const missing = error instanceof ServiceError && error.code === "missing"
  const code = error instanceof ServiceError ? error.code : ""
  const localized =
    error instanceof ZodError || code === "invalid-argument"
      ? publicText(lang, "invalidForm")
      : code === "resource-exhausted"
        ? publicText(lang, "tooMany")
        : code === "failed-precondition"
          ? publicText(lang, "changed")
          : code === "uncertain"
            ? publicText(lang, "connection")
            : lang === "es"
              ? errorText(error)
              : publicText(lang, "unavailable")
  return (
    <Notice tone="error" title={missing ? publicText(lang, "missing") : undefined}>
      {permission ? publicText(lang, "unavailable") : localized}
    </Notice>
  )
}
export function NoMenu({ loading = false }: { loading?: boolean }) {
  const { lang } = usePublic()
  return (
    <Notice tone={loading ? "info" : "warning"} title={publicText(lang, loading ? "loading" : "unpublished")}>
      {loading ? undefined : publicText(lang, "unavailable")}
    </Notice>
  )
}
