import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { registro } from "../server/pares.ts";

// The ✦'s autopilot state is the supervisor's registry (`file.autopilot.pares.v1`): the plugin only reads it. Everything here
// goes through an explicit path — the machine's real ~/.company is never touched.
const dir = mkdtempSync(join(tmpdir(), "pares-"));
const ruta = (nombre: string) => join(dir, nombre);
const line = (o: object) => JSON.stringify(o);
const escribe = (nombre: string, cuerpo: string) => writeFileSync(ruta(nombre), cuerpo);
const fichero = (pares: object) => line({ version: 1, pares });
const par = (extra: object = {}) => ({ a_id: "a1", b_id: "b1", estado: "activa", motivo: "trabajando", desde: 1763100000.0, actualizado: 1763100060.0, pasos: { total: 7, seguidos: 3 }, ultimo_envio: "[AUTOPILOT] sigue", ...extra });

describe("el registro de parejas, leído", () => {
  it("fichero ausente: no hay pareja", () => {
    assert.deepEqual(registro(ruta("no-existe.json")).de("a1"), { estado: "sin-par", motivo: "" });
  });

  it("sin entrada para este agente: no hay pareja, aunque las haya para otros", () => {
    escribe("otros.json", fichero({ a2: par({ a_id: "a2" }) }));
    assert.deepEqual(registro(ruta("otros.json")).de("a1"), { estado: "sin-par", motivo: "" });
  });

  it("cada estado del Par pasa tal cual", () => {
    for (const estado of ["activa", "pensando", "esperando", "humano", "degradada", "entregada"]) {
      escribe(`e-${estado}.json`, fichero({ a1: par({ estado }) }));
      assert.equal(registro(ruta(`e-${estado}.json`)).de("a1").estado, estado);
    }
  });

  it("los campos que enseña el popover: motivo, pasos, último envío, auditor y clave; los tiempos, en ISO", () => {
    escribe("completo.json", fichero({ a1: { ...par(), key: "TAREA-1000001", modelo: "claude-opus-5-5" } }));
    const e = registro(ruta("completo.json")).de("a1");
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
    escribe("por-aid.json", fichero({ otra_clave: par() }));
    assert.equal(registro(ruta("por-aid.json")).de("a1").estado, "activa");
  });

  it("los campos extra del Par pasan y un paso sin enteros no se inventa", () => {
    escribe("extra.json", fichero({ a1: { ...par(), origen: "paseo", interna: { x: 1 }, pasos: { seguidos: "3", total: null } } }));
    const e = registro(ruta("extra.json")).de("a1");
    assert.equal(e.estado, "activa");
    assert.equal(e.pasos, undefined, "un contador que no es entero no se pinta");
  });

  it("ilegible, no-JSON o v1 incompleto: estado desconocido, sin romper nada", () => {
    escribe("roto.json", "{ no es json");
    assert.equal(registro(ruta("roto.json")).de("a1").estado, "desconocido");
    assert.match(registro(ruta("roto.json")).de("a1").motivo, /no es JSON/);
    escribe("v2.json", line({ version: 2, pares: {} }));
    assert.equal(registro(ruta("v2.json")).de("a1").estado, "desconocido");
    escribe("sin-pares.json", line({ version: 1 }));
    assert.match(registro(ruta("sin-pares.json")).de("a1").motivo, /version, pares/);
    mkdirSync(ruta("es-dir.json"), { recursive: true });
    assert.match(registro(ruta("es-dir.json")).de("a1").motivo, /no se pudo leer/);
  });

  it("un Par sin estado no se disfraza: desconocido", () => {
    escribe("sin-estado.json", fichero({ a1: { a_id: "a1" } }));
    assert.equal(registro(ruta("sin-estado.json")).de("a1").estado, "desconocido");
  });
});
