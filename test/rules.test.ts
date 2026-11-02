import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluarReglas, REGLAS } from "../service/rules.ts";

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
    assert.deepEqual(ids, ["D1", "D2", "D3", "D4", "D5", "D6", "D7", "D8", "D9"]); // D0 y D10 no son patrones
  });
});