import { MotionConfig } from "motion/react"
import { Nav } from "@/components/site/nav"
import { Hero } from "@/components/site/hero"
import { Channels, Problem, Tagline } from "@/components/site/sections-a"
import { Benefits } from "@/components/site/benefits"
import { Demo, Faq, Included, Pilot, Pricing, Steps } from "@/components/site/sections-b"
import { FinalCta, Footer } from "@/components/site/closing"

export default function App() {
  return (
    // `reducedMotion="user"`: las animaciones de motion respetan «reducir movimiento».
    <MotionConfig reducedMotion="user">
      <Nav />
      <main id="contenido" tabIndex={-1} className="outline-none">
        <Hero />
        <Channels />
        <Problem />
        <Tagline />
        <Benefits />
        <Included />
        <Steps />
        <Demo />
        <Pilot />
        <Pricing />
        <Faq />
        <FinalCta />
      </main>
      <Footer />
    </MotionConfig>
  )
}
