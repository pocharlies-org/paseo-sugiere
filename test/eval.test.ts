import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluarReglas } from "../service/rules.ts";
import { cuerpoSugerencia } from "../service/residente.ts";
import { CWD } from "./rules-fixtures.ts";
import {
  FICHEROS_PUERTA, MODELO, SONDAS, configDelServicio, VECES, autoenviaParaDani, casos, grabadas, huellaPuerta, huellaReglas, informe, jsonl, leerJson, plano,
  puntua, reglaCae,
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
    assert.equal(huellaReglas(), "dec4d76481d66245"); // D9 distingue referencias y D10 normaliza rutas.
  });

  it("cada sonda cae en su regla, de D0 a D14", () => {
    assert.deepEqual(Object.keys(SONDAS).sort(), Array.from({ length: 15 }, (_, i) => `D${i}`).sort());
    for (const [id, texto] of Object.entries(SONDAS)) assert.equal(evaluarReglas(texto, CWD)?.id, id, texto);
  });
});

describe("eval: la última corrida grabada de cada caso", () => {
  const corridas = grabadas().map((r) => leerJson(r) as Resultado);
  const ultima = corridas.at(-1) ?? null;
  // `scripts/eval --vivo --caso <id>` mide solo algunos casos (`parcial: true`): cada caso se juzga con la última corrida que lo
  // midió. Un caso que ninguna corrida midió sigue fallando aquí.
  const deCaso = (id: string) => [...corridas].reverse().find((r) => r.casos[id]);

  it("cada caso tiene sus corridas en la última corrida que lo midió", { skip: !ultima && "sin corridas grabadas" }, () => {
    for (const caso of CASOS) assert.equal(deCaso(caso.id)?.casos[caso.id]?.length, VECES, caso.id);
  });

  it("se reproduce: la puntuación de hoy da lo mismo que se grabó", { skip: !ultima && "sin corridas grabadas" }, () => {
    for (const caso of CASOS)
      deCaso(caso.id)!.casos[caso.id].forEach((c, i) => assert.equal(puntua(caso, c).pasa, c.pasa, `${caso.id} #${i + 1}: ${c.motivo}`));
  });

  // 18-11 (revisión de seguridad): sobre la última medida de CADA caso, no solo sobre la última corrida (que puede ser parcial).
  it("no autoenvía ningún PARA DANI y el servicio aplicó D0-D14, en la última medida de cada caso", { skip: !ultima && "sin corridas grabadas" }, () => {
    assert.deepEqual(CASOS.flatMap((c) => deCaso(c.id)?.casos[c.id] ?? []).filter(autoenviaParaDani), []);
    for (const r of new Set(CASOS.flatMap((c) => deCaso(c.id) ?? [])))
      for (const id of Object.keys(SONDAS)) assert.ok(reglaCae(id, r.reglas[id]), `${r.fecha} ${id}: ${r.reglas[id]}`);
  });

  // 18-11 (revisión de seguridad): una corrida parcial no puede dejar a los demás casos medidos con otra puerta.
  it("la última medida de cada caso se hizo con la puerta de hoy (cambiarla obliga a medir todos los casos)", { skip: !ultima && "sin corridas grabadas" }, () => {
    const hoy = huellaPuerta();
    for (const caso of CASOS)
      assert.equal(deCaso(caso.id)?.puerta, hoy, `${caso.id}: medido con otra puerta; lanza scripts/eval --vivo con todos los casos`);
  });

  it("la huella de la puerta cubre la rúbrica, el tamiz, las reglas, la llamada al residente, el servidor y el prompt del sugeridor", () => {
    assert.deepEqual(FICHEROS_PUERTA, ["service/juez.ts", "service/tamiz.ts", "service/rules.ts", "service/residente.ts",
      "service/server.ts", "shared/suggest.ts"]);
    assert.match(huellaPuerta(), /^[0-9a-f]{16}$/);
  });

  // 18-11 (segunda revisión): la corrida dice con qué configuración corría el servicio medido.
  it("la última medida de cada caso graba la configuración del servicio medido", { skip: !ultima && "sin corridas grabadas" }, () => {
    for (const caso of CASOS) {
      const c = deCaso(caso.id)?.config as any;
      assert.ok(c && typeof c.modelo_juez === "string" && typeof c.modelo_reserva === "string" && typeof c.brain?.modo === "string", caso.id);
    }
  });

  it("de /v1/config solo se graban nombres y booleanos, ni URLs ni rutas", () => {
    const c = configDelServicio({ modo: "sombra", modelo_juez: "j", modelo_reserva: "r", residente_url: "http://x.svc:4000",
      clave_residente: true, brain: { modo: "off", url: "http://b.svc:8888", banco: "b", token: false },
      clasificador: { pesos: false }, auditoria: { ruta: "/var/lib/x" }, token: false });
    assert.deepEqual(c, { modo: "sombra", modelo_juez: "j", modelo_reserva: "r", clave_residente: true, brain: { modo: "off", token: false },
      clasificador_pesos: false, token: false });
    assert.doesNotMatch(JSON.stringify(c), /http|\/var\//);
  });
});

describe("eval: el informe dice qué casos voltean, no solo la puntuación", () => {
  const caso = CASOS[0];
  const corridas = (pasa: boolean) => Array.from({ length: VECES }, () => ({ ms: 0, sugerencia: pasa ? caso.ejemplos.pasan[0] : caso.ejemplos.fallan[0] }));
  const r = (fecha: string, pasa: boolean): Resultado => ({ fecha, servicio: "x", veces: VECES, casos: { [caso.id]: corridas(pasa) }, reglas: {} });

  it("marca el volteo en los dos sentidos y lo nombra en la línea de volteos", () => {
    assert.match(informe([caso], r("b", true), [r("a", false)]), new RegExp(`Voltean: ${caso.id} \\(▲ voltea a pasa\\)`));
    assert.match(informe([caso], r("b", false), [r("a", true)]), new RegExp(`Voltean: ${caso.id} \\(▼ voltea a falla\\)`));
    assert.match(informe([caso], r("b", true), [r("a", true)]), /Voltean: ninguno/);
    assert.match(informe([caso], r("a", true), []), /línea base/);
  });

  // 18-11: tras una corrida parcial que no midió el caso, se compara con la última que sí lo midió (antes salía «nuevo»).
  it("compara cada caso con la última corrida anterior que lo midió, no con la inmediatamente anterior", () => {
    const parcial: Resultado = { fecha: "b", servicio: "x", veces: VECES, casos: {}, reglas: {}, parcial: true };
    const salida = informe([caso], r("c", true), [r("a", false), parcial]);
    assert.match(salida, new RegExp(`Voltean: ${caso.id} \\(▲ voltea a pasa\\)`));
    assert.match(salida, /Frente a la medida anterior de cada caso \(a\): 0\/1 casos pasaban/);
  });

  it("una corrida sin respuesta no es un volteo: se dice aparte", () => {
    const caidas = { ...r("b", false), casos: { [caso.id]: Array.from({ length: VECES }, () => ({ ms: 0, error: "fetch failed: ECONNRESET" })) } };
    assert.match(informe([caso], caidas, [r("a", true)]), /Voltean: ninguno/);
    assert.match(informe([caso], caidas, [r("a", true)]), /sin respuesta/);
    assert.match(informe([caso], r("c", true), [caidas]), /antes sin respuesta/); // ni al volver: el ▲ sería del servicio, no del sugeridor
    assert.match(informe([caso], r("c", true), [caidas]), /Voltean: ninguno/);
  });

  it("es determinista: el mismo par de corridas da el mismo informe", () => {
    assert.equal(informe(CASOS, r("b", true), [r("a", false)]), informe(CASOS, r("b", true), [r("a", false)]));
  });

  it("compara sin acentos ni mayúsculas", () => {
    assert.equal(plano("Relée el ESTADO"), "relee el estado");
  });
});
