import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { consultar, registrar, registrarCuando } from "../service/auditoria.ts";

const ruta = () => join(mkdtempSync(join(tmpdir(), "sugiere-aud-")), "auditoria.jsonl");
const base = (n: number, extra: Record<string, unknown> = {}) => ({
  ts: `2026-11-03T0${n}:00:00.000Z`, sid: "s", turno: `t${n}`, ms: 10, ok: true, riesgo: "ninguno",
  motivo: "rúbrica 0.95 (residente)", via: "residente", sugerencia: "abre el PR contra deploy/prod", ...extra,
});

describe("la auditoría de calidad", () => {
  it("guarda la sugerencia ENTERA, no los 120 caracteres del log", () => {
    const f = ruta();
    const larga = "a".repeat(3000);
    registrar({ ...base(1), sugerencia: larga }, f);
    assert.equal(consultar({}, f)[0].sugerencia.length, 3000);
  });

  it("filtra por ok, vía y ventana de fechas, y devuelve la ventana pedida", () => {
    const f = ruta();
    registrar(base(1), f);
    registrar(base(2, { ok: false, riesgo: "alto", via: "reglas", motivo: "D1: borrado" }), f);
    registrar(base(3, { via: "reglas" }), f);
    assert.equal(consultar({}, f).length, 3);
    assert.deepEqual(consultar({ ok: false }, f).map((r) => r.turno), ["t2"]);
    assert.deepEqual(consultar({ via: "reglas" }, f).map((r) => r.turno), ["t2", "t3"]);
    assert.deepEqual(consultar({ desde: "2026-11-03T02:00:00.000Z" }, f).map((r) => r.turno), ["t2", "t3"]);
    assert.deepEqual(consultar({ limit: 1 }, f).map((r) => r.turno), ["t3"]);   // las últimas, no las primeras
  });

  it("una línea rota no se lleva por delante las demás", () => {
    const f = ruta();
    registrar(base(1), f);
    appendFileSync(f, "{media línea\n");
    registrar(base(2), f);
    assert.deepEqual(consultar({}, f).map((r) => r.turno), ["t1", "t2"]);
  });

  it("la línea del veredicto espera al brain sin retrasar la respuesta", async () => {
    const f = ruta();
    registrarCuando(Promise.resolve({ modo: "sombra", ms: 8611, n: 5, motivo: "ok" }), base(1), f);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(consultar({}, f)[0].brain, { modo: "sombra", ms: 8611, n: 5, motivo: "ok" });
  });

  it("si la auditoría no se puede escribir, la puerta sigue", () => {
    assert.doesNotThrow(() => registrar(base(1), "/no/existe/auditoria.jsonl"));
  });
});