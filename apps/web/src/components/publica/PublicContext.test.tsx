import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, it } from "vitest"
import { PublicProvider, usePublic } from "./PublicContext"
function Language() {
  const { lang, setLang } = usePublic()
  return <button onClick={() => setLang("ca")}>{lang}</button>
}
beforeEach(() => {
  localStorage.clear()
  window.history.replaceState(null, "", "/")
})
it("recuerda el idioma en una visita posterior sin parámetro y da prioridad a la URL", () => {
  const first = render(
    <PublicProvider initialLang="es">
      <Language />
    </PublicProvider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "es" }))
  expect(localStorage.getItem("llenamos:public:language")).toBe("ca")
  first.unmount()
  window.history.replaceState(null, "", "/")
  const next = render(
    <PublicProvider initialLang="es">
      <Language />
    </PublicProvider>,
  )
  expect(screen.getByRole("button", { name: "ca" })).toBeTruthy()
  next.unmount()
  window.history.replaceState(null, "", "/?lang=en")
  render(
    <PublicProvider initialLang="en">
      <Language />
    </PublicProvider>,
  )
  expect(screen.getByRole("button", { name: "en" })).toBeTruthy()
})

it("conserva la preferencia al hidratar HTML del servidor con idioma predeterminado", async () => {
  const { renderToString } = await import("react-dom/server")
  const { hydrateRoot } = await import("react-dom/client")
  const { act } = await import("react")
  localStorage.setItem("llenamos:public:language", "ca")
  const app = <PublicProvider initialLang="es"><Language /></PublicProvider>
  const container = document.createElement("div")
  container.innerHTML = renderToString(app)
  document.body.append(container)
  let root: ReturnType<typeof hydrateRoot>
  await act(async () => { root = hydrateRoot(container, app) })
  expect(container.textContent).toBe("ca")
  expect(localStorage.getItem("llenamos:public:language")).toBe("ca")
  await act(async () => root.unmount())
  container.remove()
})
