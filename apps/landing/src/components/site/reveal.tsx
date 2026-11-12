import { useEffect, useRef, type ElementType, type ReactNode } from "react"
import { cn } from "@/lib/utils"

/** Sube y se enfoca suavemente cuando entra en pantalla (una sola vez). */
export function Reveal({
  as: Tag = "div",
  delay = 0,
  className,
  children,
}: {
  as?: ElementType
  delay?: number
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          el.classList.add("is-in")
          io.disconnect()
        }
      },
      { rootMargin: "0px 0px -10% 0px" }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [])

  return (
    <Tag
      ref={ref}
      className={cn("reveal", className)}
      style={{ "--reveal-delay": `${delay}ms` } as React.CSSProperties}
    >
      {children}
    </Tag>
  )
}

/** Cabecera de sección: etiqueta pequeña, título y entradilla. */
export function SectionHeading({
  eyebrow,
  title,
  text,
  className,
}: {
  eyebrow: string
  title: ReactNode
  text?: string
  className?: string
}) {
  return (
    <Reveal className={cn("mx-auto max-w-2xl text-center", className)}>
      <p className="font-mono text-xs tracking-widest text-ember uppercase">{eyebrow}</p>
      <h2 className="mt-4 text-3xl font-semibold tracking-tight md:text-5xl">{title}</h2>
      {text && <p className="mt-6 text-base text-dim md:text-lg">{text}</p>}
    </Reveal>
  )
}
