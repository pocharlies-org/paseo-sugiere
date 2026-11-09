import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { DINERO_RE, entregadoDe, esAlcance, esperasDe, estadoDe, parasDe, racha, ultimoTurno } from "../service/cierre.ts";

// El corpus lo genera el Python del supervisor (fuente de verdad de la gramática): el TS tiene que dar lo mismo, caso por caso.
const { casos } = JSON.parse(readFileSync(new URL("./fixtures/cierre.json", import.meta.url), "utf8"));

describe("la gramática del cierre, igual que el supervisor", () => {
  for (const c of casos) {
    it(c.nombre, () => {
      assert.deepEqual(esperasDe(c.texto).map((e) => e.linea), c.esperas);
      const paras = parasDe(c.texto);
      assert.deepEqual(paras.map((p) => p.quien), c.paras);
      assert.equal(paras.find((p) => p.quien === "DANI")?.texto ?? null, c.para_dani);
      assert.deepEqual(estadoDe(c.texto), c.estado);
      assert.equal(c.para_dani !== null && DINERO_RE.test(c.para_dani), c.dinero);
      assert.equal(esAlcance(c.texto), c.alcance);
      assert.deepEqual(entregadoDe(c.texto), c.entregado);
    });
  }
});

describe("ESPERA: sesion (coordinación de sesiones, coordinación con el rutador)", () => {
  const uuid = "3f2a8b1c-4d5e-4f70-8192-a3b4c5d6e7f8";
  it("sesion con UUID se reconoce, también en viñeta y backticks", () => {
    assert.deepEqual(esperasDe(`Abrí el PR.\nESPERA: sesion ${uuid} → sigo cuando el dueño termine`).map((e) => e.linea), [`sesion ${uuid}`]);
    assert.deepEqual(esperasDe(`- \`ESPERA: sesion ${uuid}\` → espero`).map((e) => e.linea), [`sesion ${uuid}`]);
    assert.deepEqual(esperasDe(`ESPERA: sesion ${uuid.toUpperCase()} → UUID ajeno al formato del daemon`), []);
  });

  it("UUID inválido no se reconoce", () => {
    for (const mal of ["no-es-uuid", "3f2a8b1c4d5e4f708192a3b4c5d6e7f8", "3f2a8b1c-4d5e-4f70-8192-a3b4c5d6e7f",
      "3f2a8b1c-4d5e-4f70-8192-a3b4c5d6e7f8x", "gggggggg-4d5e-4f70-8192-a3b4c5d6e7f8", "3f2a8b1c-4d5e-4f70-8192"]) {
      assert.deepEqual(esperasDe(`ESPERA: sesion ${mal} → nada`), [], mal);
    }
  });
});

const linea = (o: object) => JSON.stringify(o);
const usuario = (texto: string, extra: object = {}) => linea({ type: "user", timestamp: "2026-11-07T10:00:00Z", ...extra,
  message: { role: "user", content: [{ type: "text", text: texto }] } });
const asistente = (texto: string) => linea({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text: texto }] } });
const herramienta = linea({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } });

describe("el último turno y la racha del autopilot", () => {
  it("el último turno es lo que el asistente escribió tras el último mensaje real (un tool_result no lo corta)", () => {
    const t = ultimoTurno([usuario("hazlo"), asistente("empiezo"), herramienta, asistente("ESTADO: ENTREGA")]);
    assert.equal(t, "empiezo\nESTADO: ENTREGA");
    assert.equal(ultimoTurno([asistente("viejo"), usuario("otra"), asistente("nuevo")]), "nuevo");
  });

  it("cuenta los seguidos y el total; un EVENTO y un humano reinician los seguidos, el supervisor y los hooks no", () => {
    const r = racha([
      usuario("monta el autopilot"),
      usuario("[AUTOPILOT] arranca", { timestamp: "2026-11-07T10:05:00Z" }), asistente("…"),
      usuario("[AUTOPILOT] sigue"), asistente("ESPERA: ci a/b#1 → x"),
      usuario("EVENTO: ci a/b#1 → verde"), asistente("…"),
      usuario("[AUTOPILOT] fusiona"), asistente("…"),
      usuario("Stop hook feedback:\nTu turno acaba sin línea de cierre"), asistente("…"),
      usuario("RETOMA: tu turno se cortó"), asistente("…"),
      usuario("[AUTOPILOT] despliega"), asistente("…"),
    ]);
    assert.deepEqual(r, { seguidos: 2, total: 4, humanos: 0, eventos: 1, ultimo: "[AUTOPILOT] despliega",
      desde: "2026-11-07T10:05:00Z" });
    const h = racha([usuario("[AUTOPILOT] a"), usuario("no, haz otra cosa"), usuario("[AUTOPILOT] b")]);
    assert.equal(h.seguidos, 1);
    assert.equal(h.humanos, 1);
  });
});
