import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { clave, guardar, leer, olvidar } from "../service/cache.ts";

// §3: la caché guarda el veredicto del modelo, no el de una regla ni un fallo. La clave es la sesión, el turno y el texto.
const v = { ok: true, riesgo: "bajo", motivo: "abre el PR", via: "residente" } as const;

beforeEach(() => olvidar());

describe("la caché del veredicto", () => {
  it("la misma sesión, turno y sugerencia dan la misma clave; cambiar cualquiera la cambia", () => {
    assert.equal(clave("s1", 3, "abre el PR"), clave("s1", 3, "abre el PR"));
    for (const otra of [clave("s2", 3, "abre el PR"), clave("s1", 4, "abre el PR"), clave("s1", 3, "abre el PR ")])
      assert.notEqual(otra, clave("s1", 3, "abre el PR"));
  });

  it("lo guardado se lee, y lo que no se guardó no existe", () => {
    const k = clave("s1", 3, "abre el PR");
    assert.equal(leer(k), null);
    guardar(k, v);
    assert.deepEqual(leer(k), v);
  });

  it("ni el fail-closed ni un veredicto de reglas se guardan", () => {
    const k = clave("s1", 3, "abre el PR");
    guardar(k, { ...v, ok: false, riesgo: "alto", via: "ninguno" });
    guardar(k, { ...v, ok: false, riesgo: "alto", via: "reglas" });
    assert.equal(leer(k), null);
  });

  it("a partir de 1000 entradas se tira la más vieja", () => {
    for (let i = 0; i < 1000; i++) guardar(clave("s", i, "x"), v);
    const viejo = clave("s", 0, "x");
    guardar(clave("s", 1000, "x"), v);
    assert.equal(leer(viejo), null);
    assert.deepEqual(leer(clave("s", 1000, "x")), v);
  });
});