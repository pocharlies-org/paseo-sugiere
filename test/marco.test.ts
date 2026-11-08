import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marco } from "../client/marco.ts";

// El host da a la ✦ un hueco de `size` y en el móvil recorta lo que sobra (Dani 08-11: «sale cortada»): el recuadro de estado,
// su borde y el latido rojo tienen que caber siempre en ese hueco.
describe("el recuadro de la ✦ cabe en el hueco del icono", () => {
  for (const estado of ["pedible", "generando", "lista", "error", "autopilot", "pensando", "humano"]) {
    it(estado, () => {
      for (const size of [12, 14, 16, 18, 20, 24]) {
        const m = marco(size, estado);
        assert.equal(m.lado, size);
        assert.ok(m.icono + 2 * (m.borde + m.padding) <= size, `${estado}/${size}: la estrella y el borde se salen`);
        assert.ok(m.latido <= 1, `${estado}: el latido crece y se recortaría`);
      }
    });
  }
});
