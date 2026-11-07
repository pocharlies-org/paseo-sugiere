import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, mock } from "node:test";
import { SinServicio, decidir, topes } from "../service/autopilot.ts";

// Una fila de la tabla de decisión del plan del autopilot (§3) por test. Lo determinista no llama a ningún modelo; el paso
// propuesto pasa por la puerta. Las respuestas de LiteLLM se simulan: la del juez lleva la rúbrica, la de la sugerencia no.
const linea = (o: object) => JSON.stringify(o);
const u = (texto: string, ts = "2026-11-07T10:00:00Z") => linea({ type: "user", timestamp: ts,
  message: { role: "user", content: [{ type: "text", text: texto }] } });
const a = (texto: string) => linea({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5",
  content: [{ type: "text", text: texto }] } });
const ctx = { kind: "live", cwd: "/home/dani/k8s/k8s-sugiere-pocharlies" };
const yaArrancado = [u("monta el autopilot"), u("[AUTOPILOT] Autopilot activado: llevo yo esta sesión hasta la entrega."), a("vale")];

const respuesta = (texto: string) => ({ ok: true, json: async () => ({ choices: [{ message: { content: texto } }] }),
  text: async () => texto }) as any;
/** Simula LiteLLM: `paso` es la sugerencia, `juez` el JSON de la rúbrica; un Error se lanza tal cual. */
function litellm(paso: string | Error, juez: object | Error = { veredicto: "seguir", riesgo: "bajo", p: 0, motivo: "reversible" }) {
  return mock.method(globalThis, "fetch", async (_url: string, init: { body: string }) => {
    const r = init.body.includes("Rúbrica del riesgo") ? juez : paso;
    if (r instanceof Error) throw r;
    return respuesta(typeof r === "string" ? r : JSON.stringify(r));
  });
}
const sinModelo = () => mock.method(globalThis, "fetch", async () => { throw new Error("no debería llamarse a ningún modelo"); });

afterEach(() => mock.restoreAll());

describe("el autopilot, fila a fila", () => {
  it("1 · AUTOPILOT: ENTREGADO con clave y URL → cerrar", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("ESTADO: ENTREGA\nAUTOPILOT: ENTREGADO TAREA-1000001 https://artefactos.example.com/a.html")], ctx);
    assert.equal(d.accion, "cerrar");
    assert.match(d.motivo, /TAREA-1000001/);
  });

  it("2 · una ESPERA vigilable → esperar (la despierta el EVENTO del supervisor)", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("PR abierto.\nESPERA: ci pocharlies-org/paseo-sugiere#77 → fusiono")], ctx);
    assert.deepEqual([d.accion, d.motivo], ["esperar", "ci pocharlies-org/paseo-sugiere#77"]);
  });

  it("2 · una ESPERA: fichero no despierta a nadie en Paseo: no es esperar, sigue el autopilot", async () => {
    litellm("lee /tmp/salida.json y sigue");
    const d = await decidir([...yaArrancado, a("ESPERA: fichero /tmp/salida.json → la leo")], ctx);
    assert.equal(d.accion, "enviar");
  });

  it("3 · PARA IT / SECURITY / QA → esperar", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("PARA IT: falta el token del runner")], ctx);
    assert.equal(d.accion, "esperar");
  });

  it("4 · 15 pasos seguidos del autopilot → humano, sin llamar a nadie", async () => {
    sinModelo();
    const pasos = Array.from({ length: 15 }, (_, i) => [u(`[AUTOPILOT] paso ${i}`), a("hecho")]).flat();
    const d = await decidir([u("hazlo"), ...pasos, a("ESTADO: ENTREGA")], ctx);
    assert.equal(d.accion, "humano");
    assert.match(d.motivo, /15 pasos seguidos/);
  });

  it("4 · 40 pasos en la sesión → humano aunque Dani haya escrito entre medias", async () => {
    sinModelo();
    const pasos = Array.from({ length: 40 }, (_, i) => [u(`[AUTOPILOT] paso ${i}`), a("hecho"), ...(i % 10 === 9 ? [u("sigue")] : [])]).flat();
    const d = await decidir([...pasos, a("PARA DANI: ¿le cambio el nombre?")], ctx);
    assert.equal(d.accion, "humano");
    assert.match(d.motivo, /40 pasos/);
  });

  it("5 · el primer paso sin plan anclado → arranque (el ticket primero)", async () => {
    sinModelo();
    const d = await decidir([u("monta X"), a("Hecho.\nESTADO: ENTREGA")], ctx);
    assert.deepEqual([d.accion, d.fase], ["enviar", "arranque"]);
    assert.match(d.mensaje!, /^\[AUTOPILOT\] .*clasificar-trabajo/);
  });

  it("5 · con ticket conocido (aunque el ancla no tenga criterios) no hay arranque, y la clave llega a la entrega", async () => {
    sinModelo();
    const d = await decidir([u("monta X"), a("Hecho.\nESTADO: ENTREGA")], { ...ctx, plan: { ticket: "TAREA-1000005", criterios: [] } });
    assert.equal(d.fase, "entregar");
    assert.match(d.mensaje!, /al ticket TAREA-1000005/);
  });

  it("7 · PARA DANI con importe → humano por dinero", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("PARA DANI (dinero): el dominio cuesta 120 € al año, ¿lo pago?")], ctx);
    assert.deepEqual([d.accion, d.riesgo], ["humano", "dinero"]);
  });

  it("7 · PARA DANI (alcance) → humano (decisión 1 de Dani)", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("PARA DANI (alcance): el brief pide X y lo correcto es Y")], ctx);
    assert.equal(d.accion, "humano");
    assert.match(d.motivo, /alcance/);
  });

  it("7 · PARA DANI sin dinero → devolver, y recuerda redeclarar la ESPERA si la había", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("ESPERA: ci a/b#9 → fusiono\n\nPARA DANI: ¿le pongo otro nombre al servicio?")], ctx);
    assert.deepEqual([d.accion, d.fase], ["enviar", "devolver"]);
    assert.match(d.mensaje!, /DECISIÓN TOMADA/);
    assert.match(d.mensaje!, /siguen en pie/);
  });

  it("7 · si insiste en preguntar a Dani justo después de devolverla → humano", async () => {
    sinModelo();
    const primera = await decidir([...yaArrancado, a("PARA DANI: ¿nombre A o B?")], ctx);
    const d = await decidir([...yaArrancado, a("PARA DANI: ¿nombre A o B?"), u(primera.mensaje!), a("PARA DANI: de verdad, ¿A o B?")], ctx);
    assert.equal(d.accion, "humano");
  });

  it("6 · ESTADO: ENTREGA sin plan → entregar, con los números del autopilot en el prompt", async () => {
    sinModelo();
    const d = await decidir([...yaArrancado, a("Todo verificado.\nESTADO: ENTREGA")], { ...ctx, key: "TAREA-1000001" });
    assert.deepEqual([d.accion, d.fase], ["enviar", "entregar"]);
    assert.match(d.mensaje!, /Generado con autopilot/);
    assert.match(d.mensaje!, /1 pasos del autopilot/);
    assert.match(d.mensaje!, /92-autopilot\.html/);
    assert.match(d.mensaje!, /AUTOPILOT: ENTREGADO <KEY>/);
  });

  it("6 · con plan, todos los criterios verificados → entregar aunque el turno no lo diga", async () => {
    sinModelo();
    const plan = { ticket: "TAREA-1000004", criterios: [{ texto: "A", status: "verificada" }, { texto: "B", status: "Verificado" }] };
    const d = await decidir([u("hazlo"), a("Comprobado B.")], { ...ctx, plan });
    assert.equal(d.fase, "entregar");
  });

  it("6 · ESTADO: ENTREGA con criterios sin verificar no entrega: propone el modelo con el plan", async () => {
    const f = litellm(JSON.stringify({ en_plan: "verificar", criterio: "C2", sugerencia: "verifica B con una llamada real" }));
    const plan = { ticket: "TAREA-1000004", criterios: [{ texto: "A", status: "verificada" }, { texto: "B", status: "abierta" }] };
    const d = await decidir([u("hazlo"), a("Hecho.\nESTADO: ENTREGA")], { ...ctx, plan });
    assert.deepEqual([d.accion, d.fase, d.mensaje], ["enviar", "seguir", "[AUTOPILOT] verifica B con una llamada real"]);
    assert.equal(f.mock.callCount(), 2); // la sugerencia y el juez
  });

  it("6 · la entrega pedida y no cerrada en el turno siguiente → humano", async () => {
    sinModelo();
    const primera = await decidir([...yaArrancado, a("ESTADO: ENTREGA")], ctx);
    const d = await decidir([...yaArrancado, a("ESTADO: ENTREGA"), u(primera.mensaje!), a("Listo.\nESTADO: ENTREGA")], ctx);
    assert.equal(d.accion, "humano");
  });

  it("8 · el paso del modelo que la puerta aprueba → enviar, con el prefijo y el modelo de la sesión", async () => {
    const f = litellm("abre el PR contra main y espera el CI");
    const d = await decidir([...yaArrancado, a("He escrito los tests.")], ctx);
    assert.deepEqual([d.accion, d.fase, d.mensaje, d.modelo], ["enviar", "seguir", "[AUTOPILOT] abre el PR contra main y espera el CI", "claude-opus-5-5"]);
    assert.equal(JSON.parse(String((f.mock.calls[0]!.arguments[1] as { body: string }).body)).model, "claude-opus-5-5");
  });

  it("8 · la sugerencia nativa ahorra la llamada al modelo de la sesión (solo juzga la puerta)", async () => {
    const f = litellm(new Error("no debería pedirse la sugerencia"));
    const d = await decidir([...yaArrancado, a("He escrito los tests.")], ctx, "corre npm test");
    assert.equal(d.mensaje, "[AUTOPILOT] corre npm test");
    assert.equal(f.mock.callCount(), 1);
  });

  it("8 · una regla dura veta el paso → desvío; un segundo veto seguido → humano", async () => {
    litellm("kubectl delete pod -n llm sugiere-0");
    const d = await decidir([...yaArrancado, a("El pod no arranca.")], ctx);
    assert.deepEqual([d.accion, d.fase, d.riesgo, d.via], ["enviar", "desvio", "alto", "reglas"]);
    const d2 = await decidir([...yaArrancado, a("El pod no arranca."), u(d.mensaje!), a("Sigue sin arrancar.")], ctx);
    assert.equal(d2.accion, "humano");
  });

  it("8 · la rúbrica dice dinero → humano, nunca se autoenvía", async () => {
    litellm("contrata el plan pro del proveedor", { veredicto: "detener", riesgo: "dinero", p: 0, motivo: "gasta" });
    const d = await decidir([...yaArrancado, a("Nos quedamos sin cuota.")], ctx);
    assert.deepEqual([d.accion, d.riesgo], ["humano", "dinero"]);
  });

  it("8 · el modelo no propone nada y el turno no cierra → humano", async () => {
    litellm("");
    const d = await decidir([...yaArrancado, a("He mirado el log.")], ctx);
    assert.equal(d.accion, "humano");
  });

  it("8 · el mismo paso que el último del autopilot → humano (bucle)", async () => {
    litellm("corre npm test");
    const d = await decidir([...yaArrancado, a("…"), u("[AUTOPILOT] corre npm test"), a("Falla un test.")], ctx);
    assert.equal(d.accion, "humano");
  });

  it("9 · el modelo no contesta → SinServicio (el servidor da 503 y el llamante reintenta)", async () => {
    litellm(new Error("timeout"));
    await assert.rejects(decidir([...yaArrancado, a("He escrito los tests.")], ctx), SinServicio);
  });

  it("9 · la puerta no disponible tampoco envía: SinServicio", async () => {
    litellm("abre el PR", new Error("residente caído"));
    await assert.rejects(decidir([...yaArrancado, a("He escrito los tests.")], ctx), SinServicio);
  });

  it("un turno sin texto → esperar (lo retoma el supervisor)", async () => {
    sinModelo();
    const soloHerramientas = linea({ type: "assistant", message: { role: "assistant", model: "claude-opus-5-5",
      content: [{ type: "tool_use", name: "Bash", input: {} }] } });
    assert.equal((await decidir([...yaArrancado, u("[AUTOPILOT] sigue"), soloHerramientas], ctx)).accion, "esperar");
  });
});

describe("los topes", () => {
  it("se leen del fichero montado; ausente o con valores raros, los de Dani (15 y 40)", () => {
    const dir = mkdtempSync(join(tmpdir(), "topes-"));
    writeFileSync(join(dir, "ok.json"), JSON.stringify({ max_seguidos: 5, max_total: 9 }));
    writeFileSync(join(dir, "raro.json"), JSON.stringify({ max_seguidos: -1, max_total: "x" }));
    assert.deepEqual(topes(join(dir, "ok.json")), { max_seguidos: 5, max_total: 9 });
    assert.deepEqual(topes(join(dir, "raro.json")), { max_seguidos: 15, max_total: 40 });
    assert.deepEqual(topes(join(dir, "no-existe.json")), { max_seguidos: 15, max_total: 40 });
  });
});
