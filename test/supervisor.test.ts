import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// The plugin's half of the supervisor's autopilot API (contract `http.supervisor.autopilot.v1`): compose the body of
// POST /autopilot/par, send the shared token, and turn the answer into ok/error. The supervisor and its HTTP are fakes;
// HOME is a scratch dir set before the modules read their paths (the plan anchor folder is fixed at import).
const HOME = mkdtempSync(join(tmpdir(), "supervisor-"));
process.env.HOME = HOME;
const { arrancarPar, apagarPar } = await import("../server/supervisor.ts");
const { sesionConGoal } = await import("../server/goal.ts");

const llamas: { url: string; metodo: string; cabeceras: Record<string, string>; cuerpo: any }[] = [];
let respuestas: { status: number; body?: object }[] = [];
let falla: Error | null = null;
globalThis.fetch = (async (url: string, init: any) => {
  if (falla) throw falla;
  llamas.push({ url: String(url), metodo: init.method, cabeceras: init.headers, cuerpo: init.body ? JSON.parse(init.body) : undefined });
  const next = respuestas.shift() ?? { status: 201 };
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
}) as typeof fetch;

const paseo = {
  agents: {
    ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: "/home/node/repos/paseo-sugiere", title: "montar el autopilot", provider: "claude" } }) }),
  },
} as never;

const escribe = (ruta: string, cuerpo: string) => {
  mkdirSync(join(ruta, ".."), { recursive: true });
  writeFileSync(ruta, cuerpo);
};

describe("arrancar la pareja", () => {
  beforeEach(() => {
    llamas.length = 0;
    respuestas = [];
    falla = null;
    process.env.SUPERVISOR_URL = "http://supervisor.example:19911";
    escribe(join(HOME, ".company", "jira-trigger", "secret"), "  token-de-prueba\n");
    rmSync(join(HOME, ".local", "state", "paseo-plan"), { recursive: true, force: true });
  });
  after(() => rmSync(HOME, { recursive: true, force: true }));

  it("con plan vinculado: el cuerpo del contrato, con la clave del ancla y el token en la cabecera", async () => {
    escribe(join(HOME, ".local", "state", "paseo-plan", "anchor-a1.json"), JSON.stringify({ ticketKey: "TAREA-1000001", criterios: [{ texto: "A" }, { texto: "B" }] }));
    const r = await arrancarPar({ agentId: "a1", modo: "plan", modelo: "claude-opus-5-5" }, paseo);
    assert.deepEqual(r, { ok: true });
    assert.equal(llamas.length, 1);
    assert.equal(llamas[0]!.url, "http://supervisor.example:19911/autopilot/par");
    assert.equal(llamas[0]!.metodo, "POST");
    assert.equal(llamas[0]!.cabeceras["X-Company-Token"], "token-de-prueba", "el contenido del secret, sin el salto de línea");
    assert.deepEqual(llamas[0]!.cuerpo, {
      a: { id: "a1", tipo: "paseo", cwd: "/home/node/repos/paseo-sugiere", titulo: "montar el autopilot" },
      objetivo: { modo: "plan", key: "TAREA-1000001" },
      modelo: "claude-opus-5-5",
      origen: "paseo",
    });
  });

  it("con prompt: el texto va en objetivo y el modelo se omite si no se eligió", async () => {
    const r = await arrancarPar({ agentId: "a1", modo: "prompt", texto: "  deja la píldora verde al entregar  " }, paseo);
    assert.deepEqual(r, { ok: true });
    assert.deepEqual(llamas[0]!.cuerpo.objetivo, { modo: "prompt", texto: "deja la píldora verde al entregar" });
    assert.equal("modelo" in llamas[0]!.cuerpo, false, "sin modelo elegido, decide el supervisor (claude-opus-5-5)");
  });

  it("plan sin ancla o prompt sin texto: error claro, sin llamar a nadie", async () => {
    assert.match((await arrancarPar({ agentId: "a1", modo: "plan" }, paseo)).error!, /plan vinculado/);
    assert.match((await arrancarPar({ agentId: "a1", modo: "prompt", texto: "   " }, paseo)).error!, /Prompt/);
    assert.equal(llamas.length, 0);
  });

  it("el 409 del supervisor se enseña con su motivo (pareja viva, A es una B o el rutador la lleva)", async () => {
    respuestas = [{ status: 409, body: { error: "A ya tiene pareja viva" } }];
    const r = await arrancarPar({ agentId: "a1", modo: "prompt", texto: "haz X" }, paseo);
    assert.equal(r.ok, false);
    assert.equal(r.error, "A ya tiene pareja viva");
  });

  it("un 503 o un cuerpo sin {error} caen al status; sin respuesta, lo dice", async () => {
    respuestas = [{ status: 503 }];
    assert.match((await arrancarPar({ agentId: "a1", modo: "prompt", texto: "haz X" }, paseo)).error!, /503/);
    falla = new Error("socket hang up");
    assert.match((await arrancarPar({ agentId: "a1", modo: "prompt", texto: "haz X" }, paseo)).error!, /no respondió \(socket hang up\)/);
  });

  it("sin token en el home, no se sale a la red", async () => {
    rmSync(join(HOME, ".company", "jira-trigger", "secret"));
    const r = await arrancarPar({ agentId: "a1", modo: "prompt", texto: "haz X" }, paseo);
    assert.equal(r.ok, false);
    assert.match(r.error!, /jira-trigger\/secret/);
    assert.equal(llamas.length, 0);
  });

  it("sin SUPERVISOR_URL, la base del clúster", async () => {
    delete process.env.SUPERVISOR_URL;
    await arrancarPar({ agentId: "a1", modo: "prompt", texto: "haz X" }, paseo);
    assert.equal(llamas[0]!.url, "http://company.paseo.svc.cluster.local:19911/autopilot/par");
    process.env.SUPERVISOR_URL = "http://supervisor.example:19911";
  });
});

describe("apagar la pareja", () => {
  beforeEach(() => {
    llamas.length = 0;
    respuestas = [];
    falla = null;
    process.env.SUPERVISOR_URL = "http://supervisor.example:19911";
    escribe(join(HOME, ".company", "jira-trigger", "secret"), "token-de-prueba");
  });

  it("DELETE a la ruta del par; 200 y 404 (ya no había pareja) son ok", async () => {
    respuestas = [{ status: 200, body: { a_id: "a1", estado: "apagada" } }, { status: 404 }];
    assert.deepEqual(await apagarPar("a1"), { ok: true });
    assert.deepEqual(await apagarPar("a1"), { ok: true });
    assert.equal(llamas[0]!.metodo, "DELETE");
    assert.equal(llamas[0]!.url, "http://supervisor.example:19911/autopilot/par/a1");
    assert.equal(llamas[0]!.cabeceras["X-Company-Token"], "token-de-prueba");
  });

  it("un rechazo se enseña con el motivo del supervisor", async () => {
    respuestas = [{ status: 409, body: { error: "esa sesión no es tuya" } }];
    const r = await apagarPar("a1");
    assert.equal(r.ok, false);
    assert.equal(r.error, "esa sesión no es tuya");
  });
});

describe("sesión con goal", () => {
  const A = "3f2a8b1c-4d5e-4f70-8192-a3b4c5d6e7f8";
  let creadas: any[] = [];
  let archivadas: string[] = [];
  let fallaCrear: Error | null = null;
  const conWorkspace = {
    agents: {
      ref: (id: string) => ({ refresh: async () => ({ agent: { id, cwd: "/home/node/k8s/nuevo", title: "deja verde el CI", provider: "claude" } }) }),
    },
    workspaces: {
      ref: (workspaceId: string) => ({
        agents: {
          create: async (opciones: object) => {
            if (fallaCrear) throw fallaCrear;
            creadas.push({ workspaceId, ...opciones });
            return { id: A, archive: async () => { archivadas.push(A); return {}; } };
          },
        },
      }),
    },
  } as never;
  beforeEach(() => {
    llamas.length = 0;
    respuestas = [];
    falla = null;
    creadas = [];
    archivadas = [];
    fallaCrear = null;
    process.env.SUPERVISOR_URL = "http://supervisor.example:19911";
    escribe(join(HOME, ".company", "jira-trigger", "secret"), "token-de-prueba");
  });

  it("crea la sesión en el workspace, sin prompt y en bypass, y arranca su pareja con el goal", async () => {
    const r = await sesionConGoal({ workspaceId: "w1", texto: "deja verde el CI\ncon la PR fusionada", sesion: "claude/claude-opus-5-5", modelo: "claude-fable-5-2" }, conWorkspace);
    assert.deepEqual(r, { ok: true, agentId: A });
    assert.deepEqual(creadas, [{ workspaceId: "w1", config: { provider: "claude/claude-opus-5-5", modeId: "bypassPermissions" }, title: "deja verde el CI" }]);
    assert.equal("prompt" in creadas[0], false, "el primer mensaje lo escribe el auditor");
    assert.deepEqual(llamas[0]!.cuerpo.objetivo, { modo: "prompt", texto: "deja verde el CI\ncon la PR fusionada" });
    assert.equal(llamas[0]!.cuerpo.a.id, A);
    assert.equal(llamas[0]!.cuerpo.modelo, "claude-fable-5-2");
    assert.deepEqual(archivadas, []);
  });

  it("si el supervisor rechaza la pareja, enseña su motivo y archiva la sesión vacía", async () => {
    respuestas = [{ status: 503, body: { error: "no se pudo crear el auditor: la CLI de Paseo no arrancó" } }];
    const r = await sesionConGoal({ workspaceId: "w1", texto: "haz X", sesion: "claude/claude-opus-5-5" }, conWorkspace);
    assert.deepEqual(r, { ok: false, error: "no se pudo crear el auditor: la CLI de Paseo no arrancó" });
    assert.deepEqual(archivadas, [A]);
  });

  it("si Paseo no crea la sesión, lo dice sin llamar al supervisor; sin token, la sesión creada se archiva", async () => {
    fallaCrear = new Error("workspace not found");
    assert.equal((await sesionConGoal({ workspaceId: "w1", texto: "haz X", sesion: "claude/x" }, conWorkspace)).error, "no se pudo crear la sesión (workspace not found)");
    assert.equal(llamas.length, 0);
    fallaCrear = null;
    rmSync(join(HOME, ".company", "jira-trigger", "secret"));
    assert.match((await sesionConGoal({ workspaceId: "w1", texto: "haz X", sesion: "claude/x" }, conWorkspace)).error!, /jira-trigger\/secret/);
    assert.deepEqual(archivadas, [A]);
  });
});
