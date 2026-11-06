import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluarReglas } from "../service/rules.ts";
import { cuerpoSugerencia } from "../service/residente.ts";
import { CWD } from "./rules-fixtures.ts";
import {
  MODELO, SONDAS, VECES, autoenviaParaDani, casos, grabadas, huellaReglas, informe, jsonl, leerJson, plano, puntua, reglaCae,
  type Resultado,
} from "../eval/eval.ts";

// El eval dorado del sugeridor sobre las respuestas GRABADAS (eval/resultados/): determinista, sin red ni modelo. La medida
// de verdad es `scripts/eval --vivo`; esto comprueba que los casos están bien escritos, que la última corrida grabada se
// reproduce y que no rompe las reglas que nunca se rompen.
const CASOS = casos();

describe("eval: los casos", () => {
  it("son al menos 12, con id único", () => {
    assert.ok(CASOS.length >= 12, `hay ${CASOS.length}`);
    assert.equal(new Set(CASOS.map((c) => c.id)).size, CASOS.length);
  });

  for (const caso of CASOS) {
    it(`${caso.id}: el trunk lo convierte en una petición con el modelo de la sesión y su brief`, () => {
      const cuerpo = cuerpoSugerencia(jsonl(caso));
      assert.ok(cuerpo, "sin cuerpo: el transcript no tiene un turno del asistente con modelo");
      const c = JSON.parse(cuerpo);
      assert.equal(c.model, MODELO);
      assert.match(c.messages[1].content, /\S/); // el brief, primer mensaje tras el sistema
      assert.ok(caso.plan.objetivo && caso.contexto.cwd && caso.espera.conducta);
    });

    it(`${caso.id}: la puntuación separa sus ejemplos (los que pasan y los que fallan)`, () => {
      // Los patrones se escriben sin acentos: el texto se compara sin ellos.
      for (const p of [...caso.espera.debe, ...caso.espera.no_debe]) assert.equal(p, p.normalize("NFD").replace(/\p{M}/gu, ""), p);
      assert.ok(caso.ejemplos.pasan.length && caso.ejemplos.fallan.length, "cada caso trae ejemplos de los dos lados");
      for (const s of caso.ejemplos.pasan) assert.equal(puntua(caso, { sugerencia: s, ms: 0, veredicto: { ok: true } }).pasa, true, s);
      for (const s of caso.ejemplos.fallan) assert.equal(puntua(caso, { sugerencia: s, ms: 0, veredicto: { ok: true } }).pasa, false, s);
    });
  }
});

describe("eval: D0-D14 sin tocar", () => {
  it("service/rules.ts es el de la línea base (cambiar una regla es cambiar la especificación, y se repinea aquí a la vista)", () => {
    assert.equal(huellaReglas(), "be8629e70a3fd58d");
  });

  it("cada sonda cae en su regla, de D0 a D14", () => {
    assert.deepEqual(Object.keys(SONDAS).sort(), Array.from({ length: 15 }, (_, i) => `D${i}`).sort());
    for (const [id, texto] of Object.entries(SONDAS)) assert.equal(evaluarReglas(texto, CWD)?.id, id, texto);
  });
});

describe("eval: la última corrida grabada", () => {
  const rutas = grabadas();
  const ultima = rutas.length ? (leerJson(rutas.at(-1)!) as Resultado) : null;

  it("existe y cubre todos los casos con sus corridas", { skip: !ultima && "sin corridas grabadas" }, () => {
    for (const caso of CASOS) assert.equal(ultima!.casos[caso.id]?.length, VECES, caso.id);
  });

  it("se reproduce: la puntuación de hoy da lo mismo que se grabó", { skip: !ultima && "sin corridas grabadas" }, () => {
    for (const caso of CASOS)
      ultima!.casos[caso.id].forEach((c, i) => assert.equal(puntua(caso, c).pasa, c.pasa, `${caso.id} #${i + 1}: ${c.motivo}`));
  });

  it("no autoenvía ningún PARA DANI y el servicio aplicó D0-D14", { skip: !ultima && "sin corridas grabadas" }, () => {
    assert.deepEqual(Object.values(ultima!.casos).flat().filter(autoenviaParaDani), []);
    for (const id of Object.keys(SONDAS)) assert.ok(reglaCae(id, ultima!.reglas[id]), `${id}: ${ultima!.reglas[id]}`);
  });
});

describe("eval: el informe dice qué casos voltean, no solo la puntuación", () => {
  const caso = CASOS[0];
  const corridas = (pasa: boolean) => Array.from({ length: VECES }, () => ({ ms: 0, sugerencia: pasa ? caso.ejemplos.pasan[0] : caso.ejemplos.fallan[0] }));
  const r = (fecha: string, pasa: boolean): Resultado => ({ fecha, servicio: "x", veces: VECES, casos: { [caso.id]: corridas(pasa) }, reglas: {} });

  it("marca el volteo en los dos sentidos y lo nombra en la línea de volteos", () => {
    assert.match(informe([caso], r("b", true), r("a", false)), new RegExp(`Voltean: ${caso.id} \\(▲ voltea a pasa\\)`));
    assert.match(informe([caso], r("b", false), r("a", true)), new RegExp(`Voltean: ${caso.id} \\(▼ voltea a falla\\)`));
    assert.match(informe([caso], r("b", true), r("a", true)), /Voltean: ninguno/);
    assert.match(informe([caso], r("a", true), null), /línea base/);
  });

  it("es determinista: el mismo par de corridas da el mismo informe", () => {
    assert.equal(informe(CASOS, r("b", true), r("a", false)), informe(CASOS, r("b", true), r("a", false)));
  });

  it("compara sin acentos ni mayúsculas", () => {
    assert.equal(plano("Relée el ESTADO"), "relee el estado");
  });
});
