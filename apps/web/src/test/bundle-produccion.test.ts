// @vitest-environment node
import { spawnSync } from "node:child_process"
import { describe, expect, it } from "vitest"

// Construcción real de producción (`postgres`): tarda más de medio minuto, así que solo con TEST_BUNDLE=1 (CI y release).
describe.skipIf(process.env.TEST_BUNDLE !== "1")("bundle de producción con postgres", () => {
  it("no contiene firebase/firestore, firebase/functions ni firebase/storage, ni como chunk diferido", { timeout: 300_000 }, () => {
    const resultado = spawnSync(process.execPath, ["scripts/check-imports.mjs"], { encoding: "utf8" })
    expect(resultado.stderr + resultado.stdout).toContain("Sin imports estáticos")
    expect(resultado.status).toBe(0)
    const build = spawnSync(process.execPath, ["scripts/check-bundle.mjs"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
    expect(build.stderr).not.toContain("contiene SDK")
    expect(build.stdout).toContain("Bundle limpio")
    expect(build.status).toBe(0)
  })
})
