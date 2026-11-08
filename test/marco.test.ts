import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CAJA, marco, puntaSparkles } from "../client/marco.ts";

// The host draws every plugin icon in a CAJA box and clips what sticks out (Dani 08-11: «sale cortada»), and a ring smaller than
// the box looked small («ese círculo es pequeño»): the ring fills the box, the star and its border fit inside, the red beat shrinks.
describe("the ✦ ring fills the host's icon box without sticking out", () => {
  for (const estado of ["pedible", "generando", "lista", "error", "autopilot", "pensando", "humano"]) {
    it(estado, () => {
      const m = marco(estado);
      assert.equal(m.lado, CAJA);
      assert.ok(m.icono + 2 * m.borde <= CAJA, `${estado}: the star and the border stick out`);
      assert.ok(m.icono >= 9, `${estado}: the star shrank below 9 px`);
      assert.ok(puntaSparkles(m.icono) < CAJA / 2 - m.borde, `${estado}: the star's tips touch the ring`);
      assert.ok(m.latido <= 1, `${estado}: the beat grows and would be clipped`);
    });
  }
});
