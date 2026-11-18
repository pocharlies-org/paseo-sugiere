import assert from "node:assert/strict";
import test from "node:test";
import { ESTADO_VACIO, type EstadoAgente } from "../shared/contract.ts";
import { agenteEn, agenteFuera, estadoAplicado, resumenDe, sinAgentes } from "../client/estado-agentes.ts";

const estado = (par: string, activo?: boolean): EstadoAgente => ({
  ...ESTADO_VACIO,
  autopilot: { estado: par, motivo: "" },
  ...(activo === undefined ? {} : { seguimiento: { activo, objetivo: "el objetivo", motivo: activo ? "siguiendo" : "parado a petición" } }),
});

const uno = (agentId: string, estadoAgente: EstadoAgente, workspaceId = "w1") => {
  sinAgentes();
  agenteEn(agentId, workspaceId);
  estadoAplicado(agentId, estadoAgente);
};

test("un agente siguiendo cuenta en su workspace; sin nada, el workspace no tiene insignia", () => {
  uno("a", estado("sin-par", true));
  assert.deepEqual(resumenDe("w1"), { enMarcha: 1, atencion: 0 });
  uno("a", estado("sin-par", false)); // parado: nadie trabaja en él
  assert.deepEqual(resumenDe("w1"), { enMarcha: 0, atencion: 0 });
});

test("los estados vivos de la pareja del auditor cuentan; entregada y desconocido no", () => {
  for (const par of ["activa", "pensando", "esperando"]) {
    uno("a", estado(par));
    assert.deepEqual(resumenDe("w1"), { enMarcha: 1, atencion: 0 }, par);
  }
  for (const par of ["entregada", "sin-par", "desconocido"]) {
    uno("a", estado(par));
    assert.deepEqual(resumenDe("w1"), { enMarcha: 0, atencion: 0 }, par);
  }
});

test("humano y degradada piden a una persona: cuentan como atencion", () => {
  for (const par of ["humano", "degradada"]) {
    uno("a", estado(par));
    assert.deepEqual(resumenDe("w1"), { enMarcha: 0, atencion: 1 }, par);
  }
});

test("un agente cuenta una vez: con el par pidiendo a una persona y el seguimiento activo, solo atencion", () => {
  uno("a", estado("humano", true));
  assert.deepEqual(resumenDe("w1"), { enMarcha: 0, atencion: 1 });
});

test("cada workspace cuenta solo los suyos, y un agente que se va deja de contar", () => {
  sinAgentes();
  agenteEn("a", "w1");
  agenteEn("b", "w2");
  agenteEn("c", "w1");
  estadoAplicado("a", estado("activa"));
  estadoAplicado("b", estado("sin-par", true));
  estadoAplicado("c", estado("degradada"));
  assert.deepEqual(resumenDe("w1"), { enMarcha: 1, atencion: 1 });
  assert.deepEqual(resumenDe("w2"), { enMarcha: 1, atencion: 0 });
  agenteFuera("a");
  assert.deepEqual(resumenDe("w1"), { enMarcha: 0, atencion: 1 });
});

test("sin lista de agentes no hay insignia aunque el servidor haya empujado estados", () => {
  sinAgentes();
  estadoAplicado("a", estado("activa"));
  assert.deepEqual(resumenDe("w1"), { enMarcha: 0, atencion: 0 });
  assert.deepEqual(resumenDe("w2"), { enMarcha: 0, atencion: 0 });
});