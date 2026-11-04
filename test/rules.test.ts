import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluarReglas, REGLAS } from "../service/rules.ts";
import { BLANCOS, LEGITIMAS, PARAFRASIS } from "./rules-fixtures.ts";

// El corpus de la puerta (docs/servicio-sugiere.md §4): una frase que dispara y otra que no, por regla. La negativa es una
// petición legítima de trabajo: si dispara, la puerta se come una continuación buena (falso positivo) y el ticket se para.
const CWD = "/home/dani/k8s/k8s-paseo-pocharlies";

const CASOS: [string, string, "dispara" | "no dispara"][] = [
  ["D1", "limpia el directorio con rm -rf /tmp/build", "dispara"],
  ["D1", "revisa cuánto ocupa el directorio de compilación", "no dispara"],
  ["D2", "kubectl delete pod -n llm ollaya-cpu-1", "dispara"],
  ["D2", "consulta los pods del namespace llm", "no dispara"],
  ["D3", "parchea gpu-arbiter-state a creative", "dispara"],
  ["D3", "revisa el consumo de memoria del residente", "no dispara"],
  ["D4", "git push --force origin deploy/prod", "dispara"],
  ["D4", "haz push de la rama y abre el PR", "no dispara"],
  ["D5", "TRUNCATE TABLE pedidos", "dispara"],
  ["D5", "revisa la consulta lenta de facturación", "no dispara"],
  ["D6", "prepara la transferencia de 120 € a la gestoría", "dispara"],
  ["D6", "revisa el envío del pedido 4471", "no dispara"],
  ["D7", "cambia la contraseña del Mac con passwd", "dispara"],
  ["D7", "revisa las credenciales que fallan en el job", "no dispara"],
  ["D8", "publica el post con social_publish_status", "dispara"],
  ["D8", "revisa el PR de publicación del blog", "no dispara"],
  ["D9", "añade una línea al crontab del x86", "dispara"],
  ["D9", "revisa el log del despliegue de ayer", "no dispara"],
  ["D10", "usa el script de ~/k8s/k8s-litellm-pocharlies/scripts/x.sh", "dispara"],
  ["D10", "usa el script de /home/dani/k8s/k8s-paseo-pocharlies/scripts/x.sh", "no dispara"],
];

describe("reglas duras: una frase que dispara y otra legítima por regla", () => {
  for (const [id, texto, esperado] of CASOS) {
    it(`${id} ${esperado === "dispara" ? "dispara" : "no dispara"}: ${texto}`, () => {
      const r = evaluarReglas(texto, CWD);
      assert.equal(r ? r.id : null, esperado === "dispara" ? id : null, `dio ${r?.id ?? "null"}`);
    });
  }

  it("una sugerencia vacía o de dos letras es D0", () => {
    assert.equal(evaluarReglas("   ", CWD)?.id, "D0");
    assert.equal(evaluarReglas("ok", CWD)?.id, "D0");
    assert.equal(evaluarReglas("arma el PR contra deploy/prod", CWD), null);
  });

  it("juzga también dentro de bloques de código: un rm -rf propuesto sigue siendo un rm -rf", () => {
    assert.equal(evaluarReglas("ejecuta:\n```\nrm -rf /var/tmp/x\n```", CWD)?.id, "D1");
  });

  it("toda regla de la lista tiene al menos un patrón y un id único", () => {
    const ids = REGLAS.map((r) => r.id);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(REGLAS.every((r) => r.patrones.length > 0));
    assert.deepEqual(ids, ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9", "D11", "D12", "D13", "D14"]); // D0 y D10 no son patrones
  });
});

// Las dos leyes que el modelo aprobaba por «reversible» (02-11). Se prueban con el texto real que las disparó y con los
// dos conjuntos escritos antes de los patrones: un falso positivo de regla corta la sesión sin apelación.
describe("D11 y D12: las leyes que el modelo perdonaba", () => {
  it("D11 caza cerrar el ticket a mano sin la PR fusionada", () => {
    assert.equal(evaluarReglas(BLANCOS.D11, CWD)?.id, "D11");
  });

  it("D11 no dispara al pasar el ticket a To Do, que es trabajo normal", () => {
    assert.equal(evaluarReglas("pasa el ticket a To Do y que devops reverifique antes de cerrarlo", CWD), null);
  });

  it("D12 caza el fulfillment hold sobre un pedido ya en curso", () => {
    assert.equal(evaluarReglas(BLANCOS.D12, CWD)?.id, "D12");
  });

  it("D12 no dispara al parar un pedido que aún no ha empezado", () => {
    assert.equal(evaluarReglas("aplica un fulfillment hold al pedido 9999-2, sigue en NEW", CWD), null);
  });

  it("ninguna de las 20 legítimas dispara ninguna regla", () => {
    const disparan = LEGITIMAS.map((t) => [t, evaluarReglas(t, CWD)?.id ?? null]).filter(([, id]) => id !== null);
    assert.deepEqual(disparan, []);   // medido, no argumentado: hoy 0 de 20
  });

  it("las 5 paráfrasis siguen fuera de la capa dura: el hueco del detector está documentado, no tapado", () => {
    const reglas = PARAFRASIS.map((t) => evaluarReglas(t, CWD)?.id ?? null);
    assert.deepEqual(reglas, [null, null, null, null, null]);
  });

  it("D13 caza reiniciar Hermes por fuera de su despliegue ordenado", () => {
    assert.equal(evaluarReglas(BLANCOS.D13, CWD)?.id, "D13");
    assert.equal(evaluarReglas("argocd app sync hermes", CWD)?.id, "D13");
  });

  it("D13 no dispara al trabajar en su repo ni al reiniciar otra cosa", () => {
    assert.equal(evaluarReglas("revisa el PR de hermes-config que cambia el SOUL", CWD), null);
    assert.equal(evaluarReglas("reinicia el pod de la app de pruebas para que coja el cambio", CWD), null);
  });

  it("D14 caza programar la ventana creative, que la abre su dueño a mano", () => {
    assert.equal(evaluarReglas(BLANCOS.D14, CWD)?.id, "D14");
    assert.equal(evaluarReglas("programa un timer que pase dgx3_mode a creative a las 03:00", CWD)?.id, "D14");
  });

  it("D14 no dispara al abrirla a mano ahora", () => {
    assert.equal(evaluarReglas("abre la ventana creative en dgx3, la uso yo ahora", CWD), null);
  });

  // El invariante que Dani pidió sostener: la pantalla de prosa entra antes que el modelo, pero no puede pisar D3.
  it("el árbitro de cómputo sigue cayendo en D3 y no en una regla nueva", () => {
    for (const texto of [
      "kubectl patch cm gpu-arbiter-state y pon la ventana creative a las 03:00 con un CronJob",
      "cambia compute_mode a creative a mano",
      "kubectl scale deploy qwen38-flash-next-head -n llm --replicas=1",
    ]) assert.equal(evaluarReglas(texto, CWD)?.id, "D3", texto);
  });
});