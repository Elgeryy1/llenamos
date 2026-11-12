// Basado en "Bento Grid" de Magic UI (MIT). Iconos de Phosphor y estilo Llenamos.
// Cambios: el fondo de cada tarjeta es decorativo (`aria-hidden`) y el enlace mide 44 px de alto.
import { type ComponentPropsWithoutRef, type ReactNode } from "react"
import { ArrowRight } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

interface BentoGridProps extends ComponentPropsWithoutRef<"div"> {
  children: ReactNode
  className?: string
}

interface BentoCardProps extends ComponentPropsWithoutRef<"div"> {
  name: string
  className: string
  background: ReactNode
  Icon: React.ElementType
  description: string
  href: string
  cta: string
}

const BentoGrid = ({ children, className, ...props }: BentoGridProps) => {
  return (
    <div
      className={cn("grid w-full auto-rows-[24rem] grid-cols-3 gap-4", className)}
      {...props}
    >
      {children}
    </div>
  )
}

const BentoCard = ({
  name,
  className,
  background,
  Icon,
  description,
  href,
  cta,
  ...props
}: BentoCardProps) => (
  <div
    className={cn(
      "group relative col-span-3 flex flex-col justify-end overflow-hidden rounded-2xl border border-white/10 bg-surface",
      "transition-all duration-700 ease-fluid hover:border-white/20",
      className
    )}
    {...props}
  >
    <div className="absolute inset-0" aria-hidden="true">{background}</div>
    <div className="relative z-10 bg-surface/70 p-6 backdrop-blur-sm">
      <div className="pointer-events-none flex transform-gpu flex-col gap-2 transition-all duration-700 ease-fluid lg:group-hover:-translate-y-8">
        <Icon weight="duotone" aria-hidden="true" className="size-8 origin-left text-ember transition-all duration-700 ease-fluid group-hover:scale-90" />
        <h3 className="text-xl font-semibold text-foreground">{name}</h3>
        <p className="max-w-lg text-sm text-dim">{description}</p>
      </div>
      <a
        href={href}
        className={cn(
          "mt-2 inline-flex min-h-11 items-center gap-2 rounded-md text-sm font-semibold text-ember outline-none focus-visible:ring-2 focus-visible:ring-ember",
          "lg:absolute lg:bottom-3 lg:left-6 lg:mt-0 lg:translate-y-8 lg:opacity-0 lg:transition-all lg:duration-700 lg:ease-fluid lg:group-hover:translate-y-0 lg:group-hover:opacity-100 lg:focus-visible:translate-y-0 lg:focus-visible:opacity-100"
        )}
      >
        {cta}
        <ArrowRight className="size-4" />
      </a>
    </div>
  </div>
)

export { BentoCard, BentoGrid }
