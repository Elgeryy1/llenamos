import { useRef, type ReactNode } from "react"
import { motion, useScroll, useTransform, useReducedMotion } from "motion/react"
import { useMediaQuery } from "@/hooks/use-media-query"

/**
 * Pantalla inclinada que se endereza y se acerca al hacer scroll.
 * Inspirada en "Container Scroll Animation" de Aceternity UI (21st.dev).
 */
export function ContainerScroll({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion()
  const mobile = useMediaQuery("(max-width: 767px)")
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start end", "end start"] })

  const rotate = useTransform(scrollYProgress, [0.05, 0.45], [reduce ? 0 : 24, 0])
  const scale = useTransform(scrollYProgress, [0.05, 0.45], reduce ? [1, 1] : mobile ? [0.92, 1] : [0.94, 1])
  const lift = useTransform(scrollYProgress, [0.05, 0.45], [reduce ? 0 : 48, 0])

  return (
    <div ref={ref} className="relative mx-auto w-full max-w-6xl px-4 [perspective:1200px]">
      <motion.div
        style={{ rotateX: rotate, scale, y: lift, transformOrigin: "50% 0%" }}
        className="rounded-3xl border border-white/10 bg-raised p-2 shadow-[0_40px_120px_-20px_rgb(0_0_0/0.8),0_0_0_1px_rgb(240_163_94/0.06)] md:p-3"
      >
        {/* 24px fuera, 8/12px de hueco: radio interior 16/12px */}
        <div className="overflow-hidden rounded-2xl bg-ink md:rounded-xl">{children}</div>
      </motion.div>
    </div>
  )
}
