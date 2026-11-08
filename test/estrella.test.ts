import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gira } from "../client/estrella.ts";

// Dani 08-11: with the autopilot on, the star is yellow and spins the whole time, waiting included; red beats instead.
describe("which states spin the ✦", () => {
  it("generating and the autopilot on spin", () => {
    for (const estado of ["generando", "pensando", "autopilot"]) assert.equal(gira(estado), true, estado);
  });
  it("the rest stay still", () => {
    for (const estado of ["pedible", "lista", "error", "humano"]) assert.equal(gira(estado), false, estado);
  });
});
