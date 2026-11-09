import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { bloqueoDelegacion } from "../server/delegation.ts";

// coordinación de sesiones — el store de coordinaciones del rutador (`$PASEO_HOME/rutador-coordinaciones.json`, contrato
// file.paseo.delegations.v1): mientras un registro reserve al producer, el autopilot no lo pilota. Todo en un HOME y una
// PASEO_HOME de scratch: el estado real del pod no se toca. El helper se prueba por ruta explícita y el bucle por env.
const HOME = mkdtempSync(join(tmpdir(), "delegacion-"));
process.env.HOME = HOME;
const PASEO_HOME = join(HOME, ".paseo");
process.env.PASEO_HOME = PASEO_HOME;
const autopilot = await import("../server/autopilot.ts");
const suggest = await import("../server/suggest.ts");
const store = join(PASEO_HOME, "rutador-coordinaciones.json");

const line = (o: object) => JSON.stringify(o);
const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};
const v1 = (delegations: object) => line({ version: 1, delegations });
const registro = (producerId: string, extra: object = {}) => ({
  [producerId]: { ownerId: "o-dani", producerId, state: "watching", ...extra },
});

describe("el store del rutador, leído validado", () => {
  const dir = mkdtempSync(join(tmpdir(), "delegacion-store-"));
  const ruta = (nombre: string) => join(dir, nombre);
  afterEach(() => { for (const f of ["ausente.json"]) rmSync(ruta(f), { force: true }); });

  it("ausente = normal: sin bloqueo", () => {
    assert.equal(bloqueoDelegacion("p1", ruta("no-existe.json")), null);
  });

  it("registro watching reserva al producer (dueño y estado en el motivo)", () => {
    write(ruta("w.json"), v1(registro("p1")));
    const b = bloqueoDelegacion("p1", ruta("w.json"));
    assert.match(b!, /o-dani/);
    assert.match(b!, /watching/);
    assert.equal(bloqueoDelegacion("otro", ruta("w.json")), null, "otro agente sigue libre");
  });

  it("paused también reserva; release (borrar el registro) libera", () => {
    write(ruta("pa.json"), v1(registro("p1", { state: "paused" })));
    assert.match(bloqueoDelegacion("p1", ruta("pa.json"))!, /paused/);
    write(ruta("pa.json"), v1({}));
    assert.equal(bloqueoDelegacion("p1", ruta("pa.json")), null);
  });

  it("los campos extra del contrato (ownerActivity, producerActivity, sentIds) pasan: no se exige forma exacta", () => {
    write(ruta("extra.json"), v1(registro("p1", { ownerActivity: { at: "2026-11-09T00:00:00Z" }, producerActivity: 3, sentIds: ["t1", "t2"] })));
    assert.match(bloqueoDelegacion("p1", ruta("extra.json"))!, /watching/);
  });

  it("entrada sin ownerId ni state: la clave reserva igual (motivo degradado, no corrupto)", () => {
    write(ruta("floja.json"), v1({ p1: { producerId: "p1" } }));
    const b = bloqueoDelegacion("p1", ruta("floja.json"));
    assert.match(b!, /sin dueño/);
    assert.match(b!, /activo/);
  });

  it("JSON corrupto, v1 incompleto o fichero ilegible: fail closed, no se reclama nada", () => {
    write(ruta("roto.json"), "{ no es json");
    assert.match(bloqueoDelegacion("p1", ruta("roto.json"))!, /corrupto/);
    write(ruta("v2.json"), line({ version: 2, delegations: {} }));
    assert.match(bloqueoDelegacion("p1", ruta("v2.json"))!, /corrupto/);
    mkdirSync(ruta("es-dir.json"), { recursive: true });
    assert.match(bloqueoDelegacion("p1", ruta("es-dir.json"))!, /ilegible/);
  });
});

// ————— el bucle del plugin sobre un store temporal —————
const transcript = [
  line({ message: { role: "user", content: "haz la tarea" } }),
  line({ message: { role: "assistant", model: "claude-opus-5-5", content: "siguiendo" } }),
].join("\n");

let answers: Array<{ status: number; body?: object }> = [];
let calls: any[] = [];
let onAsk: () => void = () => {};
const sent: string[] = [];
const archived: string[] = [];
let status = "idle";
const paseo = {
  agents: {
    list: async () => ({ entries: [{ agent: { id: "a1", cwd: "/w/repo", status, persistence: { sessionId: "s1" } } }] }),
    ref: (id: string) => ({ send: async (text: string) => void sent.push(text), archive: async () => void archived.push(id) }),
  },
} as never;
globalThis.fetch = (async (url: string, init: any) => {
  calls.push({ url, body: JSON.parse(init.body) });
  onAsk();
  const next = answers.shift() ?? { status: 503 };
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
}) as typeof fetch;

describe("el autopilot no pilota a un producer del rutador", () => {
  afterEach(() => {
    answers = [];
    calls = [];
    onAsk = () => {};
    sent.length = archived.length = 0;
    status = "idle";
    write(join(PASEO_HOME, "config.json"), "{}");
    write(join(HOME, ".claude", "projects", "p", "s1.jsonl"), transcript);
    rmSync(store, { force: true });
    rmSync(join(HOME, ".local", "state", "paseo-plan"), { recursive: true, force: true });
    suggest.cancel("a1");
  });

  it("set(true) con delegación activa: rechaza diciendo que se libere la delegación, y no queda encendido", async () => {
    write(store, v1(registro("a1")));
    await assert.rejects(() => autopilot.set("a1", true, paseo), /libera la delegación/);
    assert.equal(autopilot.get("a1").on, false);
    assert.equal(calls.length, 0, "ni siquiera pregunta al servicio");
  });

  it("set(true) con store corrupto: fail closed, tampoco enciende", async () => {
    write(store, "{ roto");
    await assert.rejects(() => autopilot.set("a1", true, paseo), /corrupto/);
    assert.equal(autopilot.get("a1").on, false);
  });

  it("set(true) sin store: normal (y se puede apagar)", async () => {
    status = "running"; // que el pase de fondo no pregunte todavía
    const r = await autopilot.set("a1", true, paseo);
    assert.equal(r.on, true);
    await autopilot.set("a1", false, paseo);
    assert.equal(autopilot.get("a1").on, false);
  });

  it("decide con delegación: rojo con el motivo, sin preguntar al servicio y sin enviar", async () => {
    status = "running";
    await autopilot.set("a1", true, paseo);
    write(store, v1(registro("a1", { state: "dispatching" })));
    status = "idle";
    await autopilot.decide("a1", "/w/repo", paseo);
    assert.equal(calls.length, 0);
    assert.deepEqual(sent, []);
    assert.equal(autopilot.get("a1").estado, "humano");
    assert.match(autopilot.get("a1").motivo, /dispatching/);
  });

  it("delegación que cae mientras el servicio piensa: no envía (recheck antes del efecto)", async () => {
    status = "running";
    await autopilot.set("a1", true, paseo);
    status = "idle";
    answers = [{ status: 200, body: { accion: "enviar", mensaje: "[AUTOPILOT] sigue", fase: "seguir", motivo: "ok" } }];
    onAsk = () => write(store, v1(registro("a1"))); // el rutador reclama justo durante la request
    await autopilot.decide("a1", "/w/repo", paseo);
    assert.equal(calls.length, 1, "sí preguntó: el enlace llegó en vuelo");
    assert.deepEqual(sent, [], "no se envía sobre una delegación activa");
    assert.equal(autopilot.get("a1").estado, "humano");
    assert.match(autopilot.get("a1").motivo, /mientras el servicio pensaba/);
  });

  it("delegación en vuelo tampoco archiva (cerrar)", async () => {
    status = "running";
    await autopilot.set("a1", true, paseo);
    status = "idle";
    answers = [{ status: 200, body: { accion: "cerrar", motivo: "entregado T-1: https://x" } }];
    onAsk = () => write(store, v1(registro("a1", { state: "result" })));
    await autopilot.decide("a1", "/w/repo", paseo);
    assert.deepEqual(archived, [], "no se archiva sobre una delegación activa");
    assert.equal(autopilot.get("a1").estado, "humano");
  });
});
