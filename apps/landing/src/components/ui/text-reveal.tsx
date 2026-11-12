// Basado en "Text Reveal" de Magic UI (MIT). Ajustado a Llenamos:
// palabras que pasan del tono apagado al color pleno una a una, con curva suave.
// Cambios: la frase se lee una sola vez con lector de pantalla (las palabras animadas
// van con `aria-hidden` y la frase entera en `sr-only`), y con «reducir movimiento» se
// enseña quieta, sin el tramo largo de desplazamiento.
import {
  useRef,
  type ComponentPropsWithoutRef,
  type FC,
  type ReactNode,
} from "react"
import { cubicBezier, motion, MotionValue, useReducedMotion, useScroll, useTransform } from "motion/react"

import { cn } from "@/lib/utils"

export interface TextRevealProps extends ComponentPropsWithoutRef<"div"> {
  children: string
}

const fluid = cubicBezier(0.32, 0.72, 0, 1)

export const TextReveal: FC<TextRevealProps> = ({ children, className }) => {
  const reduce = useReducedMotion()
  if (typeof children !== "string") {
    throw new Error("TextReveal: children must be a string")
  }
  if (reduce) {
    return (
      <div className={cn("relative z-0 mx-auto max-w-[760px] px-4 py-24 md:py-32", className)}>
        <p className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl lg:text-6xl">{children}</p>
      </div>
    )
  }
  return <AnimatedTextReveal className={className}>{children}</AnimatedTextReveal>
}

const AnimatedTextReveal: FC<{ children: string; className?: string }> = ({ children, className }) => {
  const sectionRef = useRef<HTMLDivElement | null>(null)
  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end end"],
  })
  const words = children.split(" ")

  return (
    <div ref={sectionRef} className={cn("relative z-0 h-[220vh]", className)}>
      <div className="sticky top-0 mx-auto flex h-screen max-w-[760px] items-center px-4">
        <p className="text-4xl font-semibold tracking-tight md:text-5xl lg:text-6xl">
          <span className="sr-only">{children}</span>
          <span aria-hidden="true" className="flex flex-wrap">
          {words.map((word, i) => {
            const start = 0.1 + (i / words.length) * 0.75
            const end = start + 0.75 / words.length
            return (
              <Word key={i} progress={scrollYProgress} range={[start, end]}>
                {word}
              </Word>
            )
          })}
          </span>
        </p>
      </div>
    </div>
  )
}

interface WordProps {
  children: ReactNode
  progress: MotionValue<number>
  range: [number, number]
}

const Word: FC<WordProps> = ({ children, progress, range }) => {
  const opacity = useTransform(progress, range, [0, 1], { ease: fluid })
  return (
    <span className="relative mr-3 mb-2 lg:mr-4">
      <span className="absolute text-foreground/25" aria-hidden="true">{children}</span>
      <motion.span style={{ opacity }} className="text-foreground">
        {children}
      </motion.span>
    </span>
  )
}
