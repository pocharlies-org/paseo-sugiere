import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

// El objetivo del formulario de la ✦: el texto real del plan conversacional o el último encargo humano real —
// nunca la clave de Jira por defecto. HOME, PASEO_HOME y el CLAUDE_CONFIG_DIR del proveedor son scratch dirs: HOME se fija
// antes de importar (la carpeta del ancla se fija en el import), como en supervisor.test.ts.
const HOME = mkdtempSync(join(tmpdir(), "objetivo-"));
process.env.HOME = HOME;
const PASEO = mkdtempSync(join(tmpdir(), "objetivo-paseo-"));
const CLAUDE = mkdtempSync(join(tmpdir(), "objetivo-claude-"));
process.env.PASEO_HOME = PASEO;
const { objetivoDeAgente } = await import("../server/objetivo.ts");

const paseo = { agents: { list: async () => ({ entries: [{ agent: { id: "a1", persistence: { sessionId: "s1" } } }] }) } } as never;

const ANCLAS = join(HOME, ".local", "state", "paseo-plan");
const escribeAncla = (cuerpo: object) => {
  mkdirSync(ANCLAS, { recursive: true });
  writeFileSync(join(ANCLAS, "anchor-a1.json"), JSON.stringify(cuerpo));
};
const escribeSesion = (lineas: string[]) => {
  const dir = join(CLAUDE, "projects", "proyecto");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "s1.jsonl"), lineas.join("\n"));
};
const u = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text } });
const a = (text: string) => JSON.stringify({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5", content: text } });

beforeEach(() => {
  rmSync(ANCLAS, { recursive: true, force: true });
  rmSync(join(CLAUDE, "projects"), { recursive: true, force: true });
  mkdirSync(PASEO, { recursive: true });
  writeFileSync(join(PASEO, "config.json"), JSON.stringify({ agents: { providers: { claude: { env: { CLAUDE_CONFIG_DIR: CLAUDE } } } } }));
});
after(() => {
  rmSync(HOME, { recursive: true, force: true });
  rmSync(PASEO, { recursive: true, force: true });
  rmSync(CLAUDE, { recursive: true, force: true });
  delete process.env.PASEO_HOME;
});

describe("el objetivo del formulario", () => {
  it("no importa el objetivo de un ticket encontrado en el historial", async () => {
    escribeAncla({ticketKey: "unrelated-ticket", objetivo: "portar app", criterios: [{texto: "portar"}]});
    escribeSesion([u("contar tickets sin cambiar Jira"), a("ok")]);
    assert.deepEqual(await objetivoDeAgente("a1", paseo), {objetivo: "contar tickets sin cambiar Jira"});
  });
  it("sin plan: el último encargo humano real — ni el del auditor, ni ruido, ni órdenes del sistema", async () => {
    escribeSesion([
      u("primera petición del usuario"),
      a("hecho"),
      u("[AUTOPILOT] sigue con el paso 2"),
      a("hecho"),
      u("<command-name>/sugiere</command-name>"),
      u("[tool result] la salida del comando"),
      u("RETOMA: retoma la sesión"),
      u("sube el tope a 4000 y corre la batería"),
      a("listo"),
      u("Tool loaded."),
      u("Stop hook feedback: sigue"),
    ]);
    const r = await objetivoDeAgente("a1", paseo);
    assert.equal(r.objetivo, "sube el tope a 4000 y corre la batería");
  });

  it("sin plan ni transcript en esta máquina: campo vacío, nada se inventa", async () => {
    const r = await objetivoDeAgente("a1", paseo);
    assert.deepEqual(r, { objetivo: null });
  });

});
