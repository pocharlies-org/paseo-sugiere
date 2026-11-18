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
const { apagarPar } = await import("../server/supervisor.ts");

const llamas: { url: string; metodo: string; cabeceras: Record<string, string>; cuerpo: any }[] = [];
let respuestas: { status: number; body?: object }[] = [];
let falla: Error | null = null;
globalThis.fetch = (async (url: string, init: any) => {
  if (falla) throw falla;
  llamas.push({ url: String(url), metodo: init.method, cabeceras: init.headers, cuerpo: init.body ? JSON.parse(init.body) : undefined });
  const next = respuestas.shift() ?? { status: 201 };
  return new Response(JSON.stringify(next.body ?? {}), { status: next.status });
}) as typeof fetch;

const escribe = (ruta: string, cuerpo: string) => {
  mkdirSync(join(ruta, ".."), { recursive: true });
  writeFileSync(ruta, cuerpo);
};

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
after(() => rmSync(HOME, { recursive: true, force: true }));
