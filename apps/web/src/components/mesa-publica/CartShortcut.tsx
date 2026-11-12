import { menuUi, type Language } from "@llenamos/core"
import { Button } from "@/components/ui/button"
export function CartShortcut({ count, lang }: { count: number; lang: Language }) {
  if (count === 0) return null
  return (
    <div className="sticky top-3 z-10 my-4">
      <Button variant="outline" className="h-12 w-full bg-card shadow-float" asChild>
        <a href="#pedido-publico">
          {menuUi(lang, "yourOrder")} · {count}
        </a>
      </Button>
    </div>
  )
}
