import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// «Seguir en automático»: the plugin's half. Every completed turn re-evaluates with the same engine as the pill
// (sugiereRequest → /v1/suggest, objective as a synthetic user turn) and, passing every gate, sends the next step itself.
// Before each send everything is fail closed: the real /v1/verdict on exactly the message being sent, the agent idle /
// not archived / with no permission open, the rutador's delegation fence and the supervisor's pair registry (a B is not
// followed). The service, the transcript on disk, Paseo, the rutador's store and the registry are fakes; HOME is a scratch
// dir, set before the modules read their paths. No extra session, no cron, no ticket: none of that exists here.
const HOME = mkdtempSync(join(tmpdir(), "seguimiento-"));
process.env.HOME = HOME;
process.env.PASEO_HOME = join(HOME, ".paseo");
process.env.SUGIERE_URL = "http://sugiere.test:8080";
const suggest = await import("../server/suggest.ts");

const line = (o: object) => JSON.stringify(o);
const u = (text: string) => line({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const a = (text: string) => line({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: [{ type: "text", text }] } });
const write = (path: string, body: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
};
const DELEGACION = join(process.env.PASEO_HOME, "rutador-coordinaciones.json");
const PARES = join(HOME, ".company", "jira-trigger", "autopilot-pares.json");
const TRANSCRIPT = join(HOME, ".claude", "projects", "p", "s1.jsonl");

let sugerencias: Array<{ sugerencia?: string; status?: number; promise?: Promise<{ sugerencia: string }> }> = [];
let dictamenes: Array<{ ok?: boolean; riesgo?: string; motivo?: string; status?: number; promise?: Promise<object> }> = [];
let calls: Array<{ url: string; body: any }> = [];
let sent: string[] = [];
let status = "idle";
let archivedAt: string | null = null;
let pendingPermissions: unknown = [];
let listBlock: Promise<void> | null = null; // set to hang agents.list: a start or a gate caught mid-read
let listLlamadas = 0;
const paseo = {
  agents: {
    list: async () => {
      listLlamadas++;
      if (listBlock) await listBlock;
      return { entries: [{ agent: { id: "a1", cwd: "/w/repo", status, archivedAt, pendingPermissions, persistence: { sessionId: "s1" } } }] };
    },
    ref: (id: string) => ({ send: async (text: string) => void sent.push(text) }),
  },
} as never;
const ctx = { paseo } as never;
globalThis.fetch = (async (url: string, init: any) => {
  const body = JSON.parse(init.body);
  calls.push({ url: String(url), body });
  if (String(url).includes("/v1/verdict")) {
    const d = dictamenes.shift() ?? { ok: true, riesgo: "bajo", motivo: "reversible" };
    const out = d.promise ? await d.promise : d;
    return new Response(JSON.stringify(out), { status: (out as any).status ?? 200 });
  }
  const s = sugerencias.shift() ?? { sugerencia: "" };
  const out = s.promise ? await s.promise : s;
  return new Response(JSON.stringify({ modelo: "claude-opus-5-5", ...out }), { status: (out as any).status ?? 200 });
}) as typeof fetch;

// The evaluation runs in the background (the RPC cannot wait on the service): wait for what it leaves behind. setImmediate,
// because mock.timers leaves it alone.
const until = async (done: () => boolean, what: string) => {
  const deadline = Date.now() + 10_000;
  while (!done()) {
    assert.ok(Date.now() < deadline, `timed out waiting: ${what}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};
const quiet = async () => {
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
};
const estado = () => suggest.seguimiento("a1");
const de = (ruta: string) => calls.filter((c) => c.url.includes(ruta));

describe("el seguimiento de Sugerir", () => {
  beforeEach(() => {
    suggest.dispose(); // en reinicio apagado: the memory state starts empty, like a fresh host
    suggest.setEnabled(true);
    suggest.setAuto(false);
    sugerencias = [];
    dictamenes = [];
    calls = [];
    sent = [];
    status = "idle";
    archivedAt = null;
    pendingPermissions = [];
    listBlock = null;
    listLlamadas = 0;
    write(join(HOME, ".paseo", "config.json"), "{}");
    write(TRANSCRIPT, [u("haz la tarea"), a("terminada, el informe está en /srv/informe.md")].join("\n") + "\n");
    rmSync(DELEGACION, { force: true });
    rmSync(PARES, { force: true });
    rmSync(join(HOME, ".local", "state", "paseo-plan"), { recursive: true, force: true });
  });
  after(() => rmSync(HOME, { recursive: true, force: true }));

  it("arranca sobre una sesión idle y reevalúa por cada turno completado: del arranque al segundo turno", async () => {
    sugerencias = [{ sugerencia: "ejecuta los tests antes del merge" }, { sugerencia: "abre el PR contra deploy/prod" }];
    const r = await suggest.seguir("a1", "terminar el informe con su CI verde", ctx);
    assert.equal(r.ok, true);
    await until(() => sent.length === 1, "el primer envío");
    // A receives the real objective and the scope, not only the model's text.
    assert.match(sent[0], /^\[SEGUIMIENTO\] Objetivo: terminar el informe con su CI verde\nAlcance: /);
    assert.ok(sent[0].endsWith("ejecuta los tests antes del merge"));
    assert.equal(estado()?.activo, true);
    assert.match(estado()!.motivo, /^enviado: ejecuta los tests/);
    // The judge ruled on exactly the message sent, with the session's cwd.
    assert.equal(de("/v1/verdict").length, 1);
    assert.equal(de("/v1/verdict")[0].body.sugerencia, sent[0], "el dictamen juzga exactamente el mensaje enviado");
    assert.equal(de("/v1/verdict")[0].body.contexto.cwd, "/w/repo");
    // The engine is the pill's: /v1/suggest with the objective as a synthetic user turn, no Jira plan.
    assert.equal(de("/v1/suggest").length, 1);
    assert.equal(de("/v1/suggest")[0].body.contexto.plan, undefined, "objetivo conversacional: sin plan de Jira");
    const sintetica = JSON.parse(de("/v1/suggest")[0].body.transcript.split("\n").filter(Boolean).at(-1)!);
    assert.equal(sintetica.message.role, "user");
    assert.match(sintetica.message.content[0].text, /terminar el informe/);
    // Our send started a turn (turn_started → cancel) and it ended completed: arm re-evaluates → second turn, second send.
    suggest.cancel("a1");
    suggest.arm("a1", ctx);
    await until(() => sent.length === 2, "el segundo turno");
    assert.ok(sent[1].endsWith("abre el PR contra deploy/prod"));
    assert.match(sent[1], /^\[SEGUIMIENTO\] Objetivo: terminar el informe/);
    assert.equal(estado()?.activo, true);
  });

  it("objetivo null es PARAR (contrato): parada inmediata que invalida el envío y el arranque en vuelo", async () => {
    // (a) active with an evaluation in flight: the stop lands first and the late answer is never sent.
    let resolver!: (v: { sugerencia: string }) => void;
    sugerencias = [{ promise: new Promise((r) => (resolver = r)) }];
    await suggest.seguir("a1", "objetivo claro", ctx);
    await until(() => de("/v1/suggest").length === 1, "la evaluación en vuelo");
    assert.deepEqual(await suggest.seguir("a1", null, ctx), { ok: true });
    assert.equal(estado()?.activo, false);
    assert.match(estado()!.motivo, /parado a petición/);
    resolver({ sugerencia: "sigue con el plan" });
    await quiet();
    assert.deepEqual(sent, [], "la parada invalida lo que estaba en vuelo");
    suggest.arm("a1", ctx); // a completed event does not revive a stopped follow-up
    await quiet();
    assert.deepEqual(sent, []);
    // (b) a start in flight: the stop aborts it and nothing is installed.
    suggest.dispose();
    let abrirLista!: () => void;
    listBlock = new Promise((r) => (abrirLista = r));
    const arranque = suggest.seguir("a1", "objetivo nuevo", ctx);
    await until(() => listLlamadas >= 1, "el arranque esperando la lista");
    assert.deepEqual(await suggest.seguir("a1", null, ctx), { ok: true });
    abrirLista();
    listBlock = null;
    const r = await arranque;
    assert.equal(r.ok, false);
    assert.match(r.error!, /paró durante el arranque/);
    assert.equal(suggest.seguimiento("a1"), undefined, "el arranque abortado no instala seguimiento");
    // (c) stopping what is not running is ok: idempotent.
    assert.deepEqual(await suggest.seguir("a1", null, ctx), { ok: true });
  });

  it("vacío: el motor no propone paso → nada se envía, pausa sin afirmar entrega", async () => {
    sugerencias = [{ sugerencia: "" }];
    await suggest.seguir("a1", "acabar el informe", ctx);
    await until(() => estado()?.activo === false, "la pausa por vacío");
    assert.deepEqual(sent, []);
    assert.equal(de("/v1/verdict").length, 0, "sin paso que enviar no se pide dictamen");
    assert.match(estado()!.motivo, /no propuso ningún paso/);
    assert.doesNotMatch(estado()!.motivo, /entregad|trabajo hecho/, "una sugerencia vacía no afirma que nada esté entregado");
  });

  it("nada se trunca: objetivo o paso por encima del tope se rechazan", async () => {
    // (a) an objective over the cap is refused at start, not cut.
    const r = await suggest.seguir("a1", "x".repeat(3001), ctx);
    assert.equal(r.ok, false);
    assert.match(r.error!, /excede 3000 caracteres/);
    assert.equal(suggest.seguimiento("a1"), undefined);
    // (b) a step whose message would pass the verdict's 4 000 is refused before spending the judge.
    sugerencias = [{ sugerencia: "y".repeat(3950) }];
    await suggest.seguir("a1", "acabar el informe", ctx);
    await until(() => estado()?.activo === false, "el rechazo del paso largo");
    assert.deepEqual(sent, []);
    assert.equal(de("/v1/verdict").length, 0, "el exceso se rechaza antes de gastar al juez");
    assert.match(estado()!.motivo, /excede el tope del dictamen \(4000\): rechazado, no se trunca/);
  });

  it("veto: el dictamen dice que no → nada se envía, pausa con el motivo del juez", async () => {
    sugerencias = [{ sugerencia: "paga el dominio del cliente" }];
    dictamenes = [{ ok: false, riesgo: "dinero", motivo: "D6: importe o pago en el mensaje" }];
    await suggest.seguir("a1", "migrar el dominio", ctx);
    await until(() => estado()?.activo === false, "la pausa por veto");
    assert.deepEqual(sent, []);
    assert.match(estado()!.motivo, /veto del juez \(dinero\): D6/);
  });

  it("dictamen fail closed: sin respuesta clara del juez no se envía", async () => {
    sugerencias = [{ sugerencia: "sigue con el plan" }, { sugerencia: "sigue con el plan dos" }];
    dictamenes = [{ status: 503, motivo: "residente caído" }, {}]; // a refusal, and a body without `ok`
    await suggest.seguir("a1", "desplegar", ctx);
    await until(() => estado()?.activo === false, "la pausa del primer dictamen");
    assert.deepEqual(sent, []);
    assert.match(estado()!.motivo, /dictamen ausente o ambiguo \(fail closed\)/);
    suggest.dispose();
    await suggest.seguir("a1", "desplegar", ctx);
    await until(() => estado()?.activo === false, "la pausa del dictamen ambiguo");
    assert.deepEqual(sent, []);
    assert.match(estado()!.motivo, /dictamen ausente o ambiguo/);
  });

  it("stop mientras espera: finFallido con el motor pensando → la respuesta tardía nunca se envía", async () => {
    let resolver!: (v: { sugerencia: string }) => void;
    sugerencias = [{ promise: new Promise((r) => (resolver = r)) }];
    await suggest.seguir("a1", "desplegar el panel", ctx);
    await until(() => de("/v1/suggest").length === 1, "la llamada en vuelo");
    suggest.finFallido("a1"); // the user hit Esc while the engine was thinking
    resolver({ sugerencia: "sigue con el plan" });
    await quiet();
    assert.deepEqual(sent, [], "nunca se envía tras parar");
    assert.equal(estado()?.activo, false);
    assert.match(estado()!.motivo, /canceló o falló/);
  });

  it("repetición: el mismo paso dos turnos seguidos no se envía, se pausa antes del juez", async () => {
    sugerencias = [{ sugerencia: "ejecuta los tests" }, { sugerencia: "ejecuta los tests" }];
    await suggest.seguir("a1", "dejar verde el CI", ctx);
    await until(() => sent.length === 1, "el primer envío");
    suggest.cancel("a1");
    suggest.arm("a1", ctx);
    await until(() => estado()?.activo === false, "la pausa por repetición");
    assert.equal(sent.length, 1, "el segundo paso idéntico no se envía");
    assert.equal(de("/v1/verdict").length, 1, "la repetición para antes de gastar al juez");
    assert.match(estado()!.motivo, /se repite/);
  });

  it("ownership: el rutador y el supervisor mandan — delegación, B, A pilotada y registro ilegible", async () => {
    // (a) the rutador holds a1 as a producer: «Seguir» refuses, nothing is asked or sent.
    write(DELEGACION, line({ version: 1, delegations: { a1: { ownerId: "dueno", producerId: "a1", state: "activo" } } }));
    const rd = await suggest.seguir("a1", "haz algo", ctx);
    assert.equal(rd.ok, false);
    assert.match(rd.error!, /delegación del rutador/);
    assert.equal(estado(), undefined);
    // (b) a1 is the auditor B of a pair: the supervisor's loop owns it.
    rmSync(DELEGACION, { force: true });
    write(PARES, line({ version: 1, pares: { "T-1": { a_id: "otro", b_id: "a1", estado: "activa" } } }));
    const rb = await suggest.seguir("a1", "haz algo", ctx);
    assert.equal(rb.ok, false);
    assert.match(rb.error!, /auditora B/);
    // (c) a1 is the A of a live pair: the supervisor already pilots it.
    write(PARES, line({ version: 1, pares: { "T-2": { a_id: "a1", b_id: "b2", estado: "activa" } } }));
    const ra = await suggest.seguir("a1", "haz algo", ctx);
    assert.equal(ra.ok, false);
    assert.match(ra.error!, /ya pilota/);
    // (d) a registry that cannot be read is fail closed: no guarantees, no follow.
    write(PARES, "no-es-json");
    const rc = await suggest.seguir("a1", "haz algo", ctx);
    assert.equal(rc.ok, false);
    assert.match(rc.error!, /no es JSON/);
    rmSync(PARES, { force: true });
    assert.deepEqual(sent, []);
  });

  it("ownership en vuelo: una delegación que llega mientras piensa el motor tumba el envío antes del juez", async () => {
    let resolver!: (v: { sugerencia: string }) => void;
    sugerencias = [{ promise: new Promise((r) => (resolver = r)) }];
    await suggest.seguir("a1", "seguir solo", ctx);
    await until(() => de("/v1/suggest").length === 1, "la llamada en vuelo");
    write(DELEGACION, line({ version: 1, delegations: { a1: { ownerId: "dueno", producerId: "a1", state: "activo" } } }));
    resolver({ sugerencia: "sigue con el plan" });
    await until(() => estado()?.activo === false, "la pausa por la delegación");
    assert.deepEqual(sent, []);
    assert.equal(de("/v1/verdict").length, 0, "el fence del rutador cierra antes de gastar al juez");
    assert.match(estado()!.motivo, /rutador/);
  });

  it("revalida tras el dictamen: si la sesión dejó de estar libre o el rutador enlazó, no se envía", async () => {
    // (a) a turn started while the judge was thinking: the pre-send re-check of idle stops the send.
    let abrirJuez!: (v: object) => void;
    sugerencias = [{ sugerencia: "ejecuta los tests" }];
    dictamenes = [{ promise: new Promise((r) => (abrirJuez = r)) }];
    await suggest.seguir("a1", "dejar verde el CI", ctx);
    await until(() => de("/v1/verdict").length === 1, "el dictamen en vuelo");
    status = "running";
    abrirJuez({ ok: true, riesgo: "bajo", motivo: "reversible" });
    await until(() => estado()?.activo === false, "la revalidación del estado");
    assert.deepEqual(sent, []);
    assert.match(estado()!.motivo, /no está libre \(status running\)/);
    // (b) the rutador linked the session while the judge was thinking: nothing goes out over an active record.
    suggest.dispose();
    status = "idle";
    let abrirJuez2!: (v: object) => void;
    sugerencias = [{ sugerencia: "ejecuta los tests" }];
    dictamenes = [{ promise: new Promise((r) => (abrirJuez2 = r)) }];
    await suggest.seguir("a1", "dejar verde el CI", ctx);
    await until(() => de("/v1/verdict").length === 2, "el segundo dictamen en vuelo");
    write(DELEGACION, line({ version: 1, delegations: { a1: { ownerId: "dueno", producerId: "a1", state: "activo" } } }));
    abrirJuez2({ ok: true, riesgo: "bajo", motivo: "reversible" });
    await until(() => estado()?.activo === false, "la revalidación del rutador");
    assert.deepEqual(sent, []);
    assert.match(estado()!.motivo, /rutador enlazó la sesión mientras el juez pensaba/);
  });

  it("permisos abiertos: el seguimiento espera, nunca la autoriza", async () => {
    pendingPermissions = [{ requestId: "p1" }];
    sugerencias = [{ sugerencia: "sigue con el plan" }];
    await suggest.seguir("a1", "seguir solo", ctx);
    await until(() => estado()?.activo === false, "la pausa por el permiso");
    assert.deepEqual(sent, []);
    assert.equal(de("/v1/verdict").length, 0);
    assert.match(estado()!.motivo, /nunca autoriza permisos/);
  });

  it("sesión que ya no espera al asistente (externo): no se envía", async () => {
    write(TRANSCRIPT, [u("haz la tarea"), a("hecho"), u("y ahora?")].join("\n") + "\n");
    await suggest.seguir("a1", "acabar", ctx);
    await until(() => estado()?.activo === false, "la pausa por externo");
    assert.deepEqual(sent, []);
    assert.equal(de("/v1/suggest").length, 0, "con un mensaje de usuario sin responder no se pregunta al motor");
    assert.match(estado()!.motivo, /fuera/);
  });

  it("dedup concurrente: dos «Seguir» a la vez comparten un solo arranque y un solo envío", async () => {
    sugerencias = [{ sugerencia: "ejecuta los tests" }];
    const [r1, r2] = await Promise.all([suggest.seguir("a1", "dejar verde el CI", ctx), suggest.seguir("a1", "dejar verde el CI", ctx)]);
    assert.equal(r1.ok, true);
    assert.equal(r2.ok, true);
    await until(() => sent.length === 1, "el único envío");
    await quiet();
    assert.equal(de("/v1/suggest").length, 1, "un arranque, una evaluación");
    assert.equal(sent.length, 1);
    // a «Seguir» while it is already following is a no-op, not a second loop
    const r3 = await suggest.seguir("a1", "dejar verde el CI", ctx);
    assert.equal(r3.ok, true);
    await quiet();
    assert.equal(sent.length, 1);
  });

  it("en reinicio apagado: dispose deja el seguimiento fuera y arm no lo reanima", async () => {
    sugerencias = [{ sugerencia: "paso uno" }, { sugerencia: "paso dos" }];
    await suggest.seguir("a1", "objetivo", ctx);
    await until(() => sent.length === 1, "el primer envío");
    suggest.dispose(); // what the host does on unload / settings off: the memory state is gone
    assert.equal(suggest.seguimiento("a1"), undefined);
    suggest.arm("a1", ctx);
    await quiet();
    assert.equal(sent.length, 1, "nada se reanuda solo tras el reinicio");
  });
});
