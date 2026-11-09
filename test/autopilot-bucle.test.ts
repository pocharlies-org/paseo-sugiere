import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it, mock } from "node:test";

// The plugin's half of the autopilot (docs/servicio-sugiere.md §12): ask /v1/autopilot once per completed turn and obey. The
// service, the transcript on disk and Paseo are fakes; HOME is a scratch dir, set before the modules read their paths.
const HOME = mkdtempSync(join(tmpdir(), "autopilot-bucle-"));
process.env.HOME = HOME;
process.env.PASEO_HOME = join(HOME, ".paseo");
const autopilot = await import("../server/autopilot.ts");
const suggest = await import("../server/suggest.ts");

const line = (o: object) => JSON.stringify(o);
const transcript = (last: "user" | "assistant") =>
  [line({ message: { role: "user", content: "haz la tarea" } }), line({ message: { role: "assistant", model: "claude-opus-5-5", content: "ESPERA: ci" } }),
    ...(last === "user" ? [line({ message: { role: "user", content: "[AUTOPILOT] sigue" } })] : [])].join("\n");
const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};

let answers: Array<{ status: number; body?: object }> = [];
let calls: any[] = [];
const sent: string[] = [];
const archived: string[] = [];
let status = "idle";
let listFails = 0; // the next N agent lists fail, as with a saturated daemon
const sendOpts: any[] = [];
const paseo = {
  agents: {
    list: async () => {
      if (listFails > 0 && listFails--) throw new Error("Plugin RPC timed out");
      return { entries: [{ agent: { id: "a1", cwd: "/w/repo", status, persistence: { sessionId: "s1" } } }] };
    },
    ref: (id: string) => ({ send: async (text: string, opts?: object) => { sent.push(text); sendOpts.push(opts); }, archive: async () => void archived.push(id) }),
  },
} as never;
globalThis.fetch = (async (url: string, init: any) => {
  calls.push({ url, body: JSON.parse(init.body) });
  const next = answers.shift() ?? { status: 503 };
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
}) as typeof fetch;
// Switching on decides in the background (the RPC cannot wait 330 s), over real file reads: wait for what it leaves behind.
// setImmediate, because mock.timers leaves it alone.
const until = async (done: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const quiet = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve))); // only where nothing must happen
const estado = () => autopilot.get("a1").estado;
const brief = () => (({ on, estado, motivo }) => ({ on, estado, motivo }))(autopilot.get("a1")); // the three fields the ✦ paints
const file = () => JSON.parse(readFileSync(join(HOME, ".local", "state", "paseo-sugiere", "autopilot.json"), "utf8"));

describe("the autopilot loop of the plugin", () => {
  beforeEach(async () => {
    answers = [];
    calls = [];
    sent.length = archived.length = sendOpts.length = 0;
    status = "idle";
    write(join(HOME, ".paseo", "config.json"), "{}");
    write(join(HOME, ".claude", "projects", "p", "s1.jsonl"), transcript("assistant"));
    rmSync(join(HOME, ".local", "state", "paseo-plan"), { recursive: true, force: true });
    suggest.cancel("a1"); // a new turn for every case
    await autopilot.set("a1", false, paseo);
  });
  after(() => rmSync(HOME, { recursive: true, force: true }));

  it("switched on over a session waiting on the user, asks at once; enviar sends the message", async () => {
    answers = [{ status: 200, body: { accion: "enviar", mensaje: "[AUTOPILOT] sigue con los tests", fase: "seguir", motivo: "ok", pasos: { seguidos: 3, total: 7 } } }];
    autopilot.setTopes(15, 0);
    await autopilot.set("a1", true, paseo);
    await until(() => sent.length === 1, "the send");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/v1\/autopilot$/);
    const { contexto, sid, turno, nativa } = calls[0].body;
    assert.deepEqual(contexto, { kind: "live", cwd: "/w/repo", topes: { max_seguidos: 15, max_total: 0 } });
    assert.equal(sid, "a1");
    assert.ok(turno, "the service refuses a falsy turno");
    assert.equal(nativa, undefined);
    assert.deepEqual(sent, ["[AUTOPILOT] sigue con los tests"]);
    assert.deepEqual(sendOpts, [{ activeTurnBehavior: "steer" }], "el autoenvío se declara steer (coordinación de sesiones; la SDK 0.11.2 aún no tiene sourceAgentId)");
    assert.equal(file().a1.on, true);
    assert.equal(file().a1.estado, "activo");
    // What the popover shows besides the state: the step count, when it decided, what it sent.
    const { pasos, decidido, enviado, desde } = autopilot.get("a1");
    assert.deepEqual(pasos, { seguidos: 3, total: 7 });
    assert.equal(enviado, "[AUTOPILOT] sigue con los tests");
    assert.ok(Date.parse(decidido!) >= Date.parse(desde!));
    await autopilot.set("a1", false, paseo);
    assert.equal(autopilot.get("a1").pasos, undefined, "a new run starts its own count");
    autopilot.setTopes(0, 0);
  });

  it("sends the anchor's key and plan, and no native suggestion with a guarded plan; the native one without it", async () => {
    write(join(HOME, ".local", "state", "paseo-plan", "anchor-a1.json"), line({ ticketKey: "ticket-1", guard: true, criterios: ["c"] }));
    write(join(HOME, ".paseo", ".paseo", "suggest", "s1.json"), line({ text: "nativa", at: Date.now() }));
    answers = [{ status: 200, body: { accion: "esperar", motivo: "ESPERA: ci" } }];
    await autopilot.set("a1", true, paseo);
    await until(() => estado() === "esperando", "esperar");
    assert.equal(calls[0].body.contexto.key, "ticket-1");
    assert.equal(calls[0].body.contexto.plan.ticketKey, "ticket-1");
    assert.equal(calls[0].body.nativa, undefined);
    rmSync(join(HOME, ".local", "state", "paseo-plan"), { recursive: true, force: true });
    suggest.cancel("a1");
    answers = [{ status: 200, body: { accion: "esperar", motivo: "ESPERA: ci" } }];
    await autopilot.decide("a1", "/w/repo", paseo, "t2");
    assert.equal(calls[1].body.nativa, "nativa");
    assert.equal(calls[1].body.contexto.key, undefined);
    assert.equal(calls[1].body.turno, "t2");
  });

  it("esperar leaves it gold with the reason; humano turns it red until the next turn starts", async () => {
    answers = [{ status: 200, body: { accion: "esperar", motivo: "ESPERA: ci" } }];
    await autopilot.set("a1", true, paseo);
    await until(() => estado() === "esperando", "esperar");
    assert.deepEqual(brief(), { on: true, estado: "esperando", motivo: "ESPERA: ci" });
    assert.deepEqual(sent, []);
    suggest.cancel("a1");
    answers = [{ status: 200, body: { accion: "humano", motivo: "dinero: PARA DANI con importe" } }];
    await autopilot.decide("a1", "/w/repo", paseo);
    assert.deepEqual(brief(), { on: true, estado: "humano", motivo: "dinero: PARA DANI con importe" });
    autopilot.turnStarted("a1");
    assert.deepEqual(brief(), { on: true, estado: "activo", motivo: "" });
  });

  it("cerrar archives the agent and switches the autopilot off as delivered", async () => {
    answers = [{ status: 200, body: { accion: "cerrar", motivo: "entregado ticket-1: https://x" } }];
    await autopilot.set("a1", true, paseo);
    await until(() => archived.length === 1, "the archive");
    assert.deepEqual(archived, ["a1"]);
    assert.deepEqual(brief(), { on: false, estado: "entregado", motivo: "entregado ticket-1: https://x" });
  });

  it("a 503 is retried once after 60 s; a second failure is humano", async () => {
    status = "running";
    await autopilot.set("a1", true, paseo); // on, without asking yet
    status = "idle";
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      answers = [{ status: 503 }, { status: 200, body: { accion: "enviar", mensaje: "[AUTOPILOT] x", fase: "seguir", motivo: "" } }];
      const first = autopilot.decide("a1", "/w/repo", paseo);
      await until(() => calls.length === 1, "the first ask");
      await quiet();
      assert.match(autopilot.get("a1").motivo, /respondió 503; reintento en 60 s/, "the popover says it is retrying, not «working»");
      assert.equal(calls.length, 1, "no retry before the 60 s");
      await until(() => (mock.timers.tick(60_000), calls.length === 2), "the retry");
      await first;
      suggest.cancel("a1");
      answers = [{ status: 503 }, { status: 503 }];
      const second = autopilot.decide("a1", "/w/repo", paseo);
      await until(() => (mock.timers.tick(60_000), calls.length === 4), "the second retry");
      await second;
    } finally {
      mock.timers.reset();
    }
    assert.ok(sent.includes("[AUTOPILOT] x"), "the retried answer is obeyed");
    assert.equal(calls.length, 4);
    assert.equal(autopilot.get("a1").estado, "humano");
    assert.match(autopilot.get("a1").motivo, /sin servicio \(503\)/);
  });

  it("a failed read of the session is retried once after 60 s; a second failure is humano with its cause", async () => {
    status = "running";
    await autopilot.set("a1", true, paseo);
    status = "idle";
    mock.timers.enable({ apis: ["setTimeout"] });
    try {
      listFails = 1;
      answers = [{ status: 200, body: { accion: "enviar", mensaje: "[AUTOPILOT] y", fase: "seguir", motivo: "" } }];
      const first = autopilot.decide("a1", "/w/repo", paseo);
      await until(() => /reintento en 60 s/.test(autopilot.get("a1").motivo ?? ""), "the retry notice");
      assert.match(autopilot.get("a1").motivo!, /no se pudo leer la sesión: the session could not be read \(Plugin RPC timed out\)/);
      assert.equal(calls.length, 0, "nothing asked before the retry");
      await until(() => (mock.timers.tick(60_000), calls.length === 1), "the read retried");
      await first;
      suggest.cancel("a1");
      listFails = 2;
      const second = autopilot.decide("a1", "/w/repo", paseo);
      await until(() => (mock.timers.tick(60_000), estado() === "humano"), "red after the second failure");
      await second;
    } finally {
      mock.timers.reset();
      listFails = 0;
    }
    assert.deepEqual(sent, ["[AUTOPILOT] y"], "the retried read is obeyed");
    assert.equal(calls.length, 1, "the failed turn asks nothing");
    assert.match(autopilot.get("a1").motivo!, /^no se pudo leer la sesión: .*Plugin RPC timed out/);
  });

  it("drops the answer when a turn started meanwhile, and asks only once per turn", async () => {
    status = "running";
    await autopilot.set("a1", true, paseo);
    status = "idle";
    answers = [{ status: 200, body: { accion: "enviar", mensaje: "[AUTOPILOT] tarde", fase: "seguir", motivo: "" } }];
    const late = autopilot.decide("a1", "/w/repo", paseo);
    suggest.cancel("a1"); // the user wrote while the service thought
    await late;
    assert.deepEqual(sent, []);
    answers = [{ status: 200, body: { accion: "esperar", motivo: "x" } }];
    await Promise.all([autopilot.decide("a1", "/w/repo", paseo), autopilot.decide("a1", "/w/repo", paseo)]);
    assert.equal(calls.length, 2, "the second ask for the same turn is skipped");
  });

  it("an invalid answer is humano, never a send", async () => {
    answers = [{ status: 200, body: { accion: "enviar", mensaje: "  " } }];
    await autopilot.set("a1", true, paseo);
    await until(() => estado() === "humano", "humano");
    assert.deepEqual(sent, []);
    assert.equal(autopilot.get("a1").estado, "humano");
  });

  it("does not ask when the last message is the user's (an unanswered RETOMA or [AUTOPILOT]) or the agent is running", async () => {
    write(join(HOME, ".claude", "projects", "p", "s1.jsonl"), transcript("user"));
    await autopilot.set("a1", true, paseo);
    await new Promise((resolve) => setTimeout(resolve, 300)); // shortcut: a fixed wait can only miss a call, never fail falsely
    write(join(HOME, ".claude", "projects", "p", "s1.jsonl"), transcript("assistant"));
    status = "running";
    await autopilot.set("a1", true, paseo);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(calls.length, 0);
  });

  it("on start, evaluates the idle agents with the autopilot on once", async () => {
    answers = [{ status: 200, body: { accion: "esperar", motivo: "x" } }];
    status = "running";
    await autopilot.set("a1", true, paseo); // on, but busy: nothing asked yet
    status = "idle";
    await autopilot.resume(paseo);
    await autopilot.resume(paseo);
    assert.equal(calls.length, 1);
  });
});
