"use client"

/**
 * Idioma, marca y conexión de la web pública. El idioma se cambia sin recargar: se
 * actualiza `?lang=` en la dirección (para compartirla tal cual) y el atributo `lang`.
 */
import type { Language } from "@llenamos/core"
import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from "react"
import { firebaseConfig, type FirebaseSettings } from "@/lib/firebase/config"
import { translator, type Translate } from "@/lib/publica/i18n"

export type PublicVariant = "page" | "widget"

interface PublicContextValue {
  lang: Language
  setLang: (lang: Language) => void
  t: Translate
  variant: PublicVariant
  settings: FirebaseSettings | null
}

const isLanguage = (value: string | null): value is Language =>
  value === "es" || value === "ca" || value === "en"
function subscribeLanguage(listener: () => void) {
  window.addEventListener("storage", listener)
  window.addEventListener("llenamos:language", listener)
  return () => {
    window.removeEventListener("storage", listener)
    window.removeEventListener("llenamos:language", listener)
  }
}
const Context = createContext<PublicContextValue | null>(null)

export function PublicProvider({
  initialLang,
  variant = "page",
  children,
}: {
  initialLang: Language
  variant?: PublicVariant
  children: React.ReactNode
}) {
  const lang = useSyncExternalStore(
    subscribeLanguage,
    () => {
      const explicit = new URL(window.location.href).searchParams.get("lang")
      if (isLanguage(explicit)) return explicit
      try {
        const saved = localStorage.getItem("llenamos:public:language")
        if (isLanguage(saved)) return saved
      } catch {
        /* El idioma sigue funcionando sin almacenamiento. */
      }
      return initialLang
    },
    () => initialLang,
  )

  useEffect(() => {
    document.documentElement.lang = lang
    try {
      const explicit = new URL(window.location.href).searchParams.get("lang")
      if (isLanguage(explicit)) localStorage.setItem("llenamos:public:language", explicit)
    } catch {
      /* Almacenamiento opcional. */
    }
  }, [lang])

  const setLang = useCallback((next: Language) => {
    try {
      localStorage.setItem("llenamos:public:language", next)
    } catch {
      /* Preferencia solo durante esta visita. */
    }
    const url = new URL(window.location.href)
    url.searchParams.set("lang", next)
    window.history.replaceState(window.history.state, "", url)
    window.dispatchEvent(new Event("llenamos:language"))
  }, [])

  const value = useMemo<PublicContextValue>(
    () => ({
      lang,
      setLang,
      t: translator(lang),
      variant,
      settings: firebaseConfig.ok ? firebaseConfig.settings : null,
    }),
    [lang, setLang, variant],
  )
  return <Context.Provider value={value}>{children}</Context.Provider>
}

export function usePublic(): PublicContextValue {
  const value = useContext(Context)
  if (!value) throw new Error("usePublic necesita PublicProvider.")
  return value
}
