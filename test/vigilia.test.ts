import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { ESTADO_VACIO, type EstadoAgente } from "../shared/contract.ts";
import * as suggest from "../server/suggest.ts";
import { observa, vigilia } from "../server/vigilia.ts";

// The pills' state is pushed: one held call per app, answered when an agent's state changes, with only what changed.
const estados = new Map<string, EstadoAgente>();
const lee = (id: string) => estados.get(id) ?? ESTADO_VACIO;
const pon = (id: string, extra: Partial<EstadoAgente>) => estados.set(id, { ...ESTADO_VACIO, ...extra });

describe("la vigilia de las píldoras", () => {
  it("la primera llamada trae todo lo que tiene algo que enseñar, y solo eso", async () => {
    estados.clear();
    const v = vigilia(lee, 10);
    pon("a", { text: "sigue" });
    v.marca("a");
    v.marca("b"); // nada que enseñar: no entra
    const r = await v.espera(0);
    assert.equal(r.completo, true);
    assert.deepEqual(Object.keys(r.agentes), ["a"]);
    v.cierra();
  });

  it("retiene la llamada hasta que algo cambia y responde solo con lo que cambió", async () => {
    estados.clear();
    const v = vigilia(lee, 5_000);
    pon("a", { text: "uno" });
    v.marca("a");
    const { version } = await v.espera(0);
    const retenida = v.espera(version);
    let respondio = false;
    void retenida.then(() => (respondio = true));
    await new Promise((sigue) => setImmediate(sigue));
    assert.equal(respondio, false, "nothing changed: the call is held");
    v.marca("a"); // same state: no wake
    await new Promise((sigue) => setImmediate(sigue));
    assert.equal(respondio, false, "a mark that changes nothing a pill shows does not wake it");
    pon("b", { autopilot: { estado: "humano", motivo: "dinero" } });
    v.marca("b");
    const r = await retenida;
    assert.equal(r.completo, false);
    assert.deepEqual(Object.keys(r.agentes), ["b"]);
    assert.ok(r.version > version);
    v.cierra();
  });

  it("al vencer la retención responde vacío en la misma versión; un since de otra instancia lo trae todo", async () => {
    estados.clear();
    const v = vigilia(lee, 10);
    pon("a", { text: "x" });
    v.marca("a");
    const { version } = await v.espera(0);
    const vacia = await v.espera(version);
    assert.deepEqual(vacia, { version, completo: false, agentes: {} });
    const otra = await v.espera(version - 1_000_000_000); // a since from before this plugin started
    assert.equal(otra.completo, true);
    v.cierra();
  });

  it("un agente que vuelve a vacío se avisa a quien lo tenía, pero ya no entra en la foto completa", async () => {
    estados.clear();
    const v = vigilia(lee, 10);
    pon("a", { text: "x" });
    v.marca("a");
    const { version } = await v.espera(0);
    estados.delete("a");
    v.marca("a");
    assert.deepEqual((await v.espera(version)).agentes, { a: ESTADO_VACIO });
    assert.deepEqual((await v.espera(0)).agentes, {});
    v.cierra();
  });

  it("el servidor de sugerencias avisa de cada cambio de estado", () => {
    const avisos: string[] = [];
    suggest.alCambiar((id) => avisos.push(id));
    suggest.feedback("a", "no-es-esto");
    suggest.cancel("a");
    suggest.dispose();
    assert.deepEqual(avisos, ["a", "a", "a", "a"]);
    suggest.alCambiar(() => {});
  });

  it("un fichero reescrito por rename en el directorio vigilado llega como evento con su nombre", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vigilia-"));
    const nombres: string[] = [];
    let llega: () => void = () => {};
    const llegado = new Promise<void>((sigue) => (llega = sigue));
    const vigilante = observa(dir, (nombre) => {
      if (nombre) nombres.push(nombre);
      if (nombre === "autopilot-pares.json") llega();
    });
    writeFileSync(join(dir, "autopilot-pares.json.tmp"), "{}");
    renameSync(join(dir, "autopilot-pares.json.tmp"), join(dir, "autopilot-pares.json")); // how the supervisor writes it
    await llegado;
    assert.ok(nombres.includes("autopilot-pares.json"));
    vigilante?.close();
    assert.equal(observa(join(dir, "no-existe"), () => {}), null, "a missing directory is a warning, not a crash");
  });
});
