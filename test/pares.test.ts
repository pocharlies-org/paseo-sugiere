import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { estadoPareja, lectorParejas } from "../server/pares.ts";

// The ✦'s autopilot state is the supervisor's registry (`file.autopilot.pares.v1`): the plugin only reads it. Everything here
// goes through an explicit path — the machine's real ~/.company is never touched.
const dir = mkdtempSync(join(tmpdir(), "pares-"));
const ruta = (nombre: string) => join(dir, nombre);
const line = (o: object) => JSON.stringify(o);
const escribe = (nombre: string, cuerpo: string) => writeFileSync(ruta(nombre), cuerpo);
const registro = (pares: object) => line({ version: 1, pares });
const par = (extra: object = {}) => ({ a_id: "a1", b_id: "b1", estado: "activa", motivo: "trabajando", desde: 1763100000.0, actualizado: 1763100060.0, pasos: { total: 7, seguidos: 3 }, ultimo_envio: "[AUTOPILOT] sigue", ...extra });

describe("el registro de parejas, leído", () => {
  it("fichero ausente: no hay pareja", () => {
    assert.deepEqual(estadoPareja("a1", ruta("no-existe.json")), { estado: "sin-par", motivo: "" });
  });

  it("sin entrada para este agente: no hay pareja, aunque las haya para otros", () => {
    escribe("otros.json", registro({ a2: par({ a_id: "a2" }) }));
    assert.deepEqual(estadoPareja("a1", ruta("otros.json")), { estado: "sin-par", motivo: "" });
  });

  it("cada estado del Par pasa tal cual", () => {
    for (const estado of ["activa", "pensando", "esperando", "humano", "degradada", "entregada"]) {
      escribe(`e-${estado}.json`, registro({ a1: par({ estado }) }));
      assert.equal(estadoPareja("a1", ruta(`e-${estado}.json`)).estado, estado);
    }
  });

  it("los campos que enseña el popover: motivo, pasos, último envío, auditor y clave; los tiempos, en ISO", () => {
    escribe("completo.json", registro({ a1: { ...par(), key: "TAREA-1000001", modelo: "claude-opus-5-5" } }));
    const e = estadoPareja("a1", ruta("completo.json"));
    assert.equal(e.motivo, "trabajando");
    assert.deepEqual(e.pasos, { seguidos: 3, total: 7 });
    assert.equal(e.ultimo_envio, "[AUTOPILOT] sigue");
    assert.equal(e.auditor, "b1"); // the id; the server upgrades it to B's title
    assert.equal(e.key, "TAREA-1000001");
    assert.equal(e.modelo, "claude-opus-5-5");
    assert.equal(e.desde, new Date(1763100000.0 * 1000).toISOString());
    assert.equal(e.actualizado, new Date(1763100060.0 * 1000).toISOString());
  });

  it("la entrada también se encuentra por su a_id, no solo por la clave del mapa", () => {
    escribe("por-aid.json", registro({ otra_clave: par() }));
    assert.equal(estadoPareja("a1", ruta("por-aid.json")).estado, "activa");
  });

  it("los campos extra del Par pasan y un paso sin enteros no se inventa", () => {
    escribe("extra.json", registro({ a1: { ...par(), origen: "paseo", interna: { x: 1 }, pasos: { seguidos: "3", total: null } } }));
    const e = estadoPareja("a1", ruta("extra.json"));
    assert.equal(e.estado, "activa");
    assert.equal(e.pasos, undefined, "un contador que no es entero no se pinta");
  });

  it("ilegible, no-JSON o v1 incompleto: estado desconocido, sin romper nada", () => {
    escribe("roto.json", "{ no es json");
    assert.equal(estadoPareja("a1", ruta("roto.json")).estado, "desconocido");
    assert.match(estadoPareja("a1", ruta("roto.json")).motivo, /no es JSON/);
    escribe("v2.json", line({ version: 2, pares: {} }));
    assert.equal(estadoPareja("a1", ruta("v2.json")).estado, "desconocido");
    escribe("sin-pares.json", line({ version: 1 }));
    assert.match(estadoPareja("a1", ruta("sin-pares.json")).motivo, /version, pares/);
    mkdirSync(ruta("es-dir.json"), { recursive: true });
    assert.match(estadoPareja("a1", ruta("es-dir.json")).motivo, /no se pudo leer/);
  });

  it("un Par sin estado no se disfraza: desconocido", () => {
    escribe("sin-estado.json", registro({ a1: { a_id: "a1" } }));
    assert.equal(estadoPareja("a1", ruta("sin-estado.json")).estado, "desconocido");
  });
});

describe("el registro leído una vez para muchos agentes (SC-5805)", () => {
  it("lectorParejas responde por cada agente lo mismo que estadoPareja", () => {
    escribe("varios.json", registro({ a1: par(), a2: par({ a_id: "a2", estado: "humano", motivo: "PARA DANI" }) }));
    const pareja = lectorParejas(ruta("varios.json"));
    for (const id of ["a1", "a2", "a3"]) assert.deepEqual(pareja(id), estadoPareja(id, ruta("varios.json")));
    assert.equal(pareja("a2").estado, "humano");
    assert.equal(pareja("a3").estado, "sin-par");
  });
});
