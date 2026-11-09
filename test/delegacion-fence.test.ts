import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";

// El fence del owner en `set`: el rutador comprueba `autopilot.json` antes de reclamar, así que el plugin releé el store
// después del put. Aquí el store está libre en la primera lectura y enlazado en la segunda (el claim cayó entre la lectura
// y la escritura): el encendido se deshace y el RPC falla. Fichero propio: mockea el módulo antes de importar (own process).
const HOME = mkdtempSync(join(tmpdir(), "delegacion-fence-"));
process.env.HOME = HOME;
process.env.PASEO_HOME = join(HOME, ".paseo");
let lecturas = 0;
mock.module(new URL("../server/delegation.ts", import.meta.url).href, {
  namedExports: {
    bloqueoDelegacion: () => (++lecturas === 1 ? null : "delegación del rutador: dueño o-dani, estado watching"),
  },
});
const autopilot = await import("../server/autopilot.ts");
const paseo = {
  agents: {
    list: async () => ({ entries: [] }),
    ref: () => ({ send: async () => {}, archive: async () => {} }),
  },
} as never;

describe("el fence de set(true)", () => {
  it("claim caído entre la lectura y el put: se deshace el encendido y el RPC falla", async () => {
    await assert.rejects(() => autopilot.set("a1", true, paseo), /libera la delegación/);
    assert.equal(autopilot.get("a1").on, false, "el on no queda puesto");
    assert.equal(autopilot.get("a1").estado, "apagado");
    assert.ok(lecturas >= 2, "el store se releé después del put");
  });
});
