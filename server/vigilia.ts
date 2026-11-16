// The pills' state is pushed, never polled. Before, every open app asked `suggest.get` for every idle agent every
// 10 s (measured 16-11: 123 agents × 3 apps ≈ 37 calls/s, ~88 % of the daemon's plugin RPCs) for an answer that almost never
// changed. Now each app holds one call: the server answers it when the state of some agent changes — the suggestion, the last
// force, the autopilot pair or the plan anchor — with only the agents that changed, or empty when the hold expires.
import { watch, type FSWatcher } from "node:fs";
import { ESTADO_VACIO, type EstadoAgente } from "../shared/contract.ts";

const RETENCION_MS = 20_000; // a held call answers by then: under the daemon's 30 s plugin request timeout

export interface Respuesta {
  version: number;
  completo: boolean;
  agentes: Record<string, EstadoAgente>;
}

export interface Vigilia {
  /** Something about this agent may have changed: read it again, and wake the held calls only if what a pill shows moved. */
  marca(agentId: string): void;
  /** The agents that changed after `since`: at once when there are some, else when one changes or the hold expires. */
  espera(since: number): Promise<Respuesta>;
  cierra(): void;
}

export function vigilia(lee: (agentId: string) => EstadoAgente, retencionMs = RETENCION_MS): Vigilia {
  // A `since` from before this instance (the plugin was reloaded) is older than its start: that caller gets everything again.
  const inicio = Date.now();
  let version = inicio;
  let cerrada = false;
  const vacio = JSON.stringify(ESTADO_VACIO);
  const estados = new Map<string, { datos: EstadoAgente; clave: string; cambio: number }>();
  const esperando = new Set<() => void>();
  const responde = (since: number): Respuesta => {
    const completo = since < inicio;
    const agentes: Record<string, EstadoAgente> = {};
    for (const [id, { datos, clave, cambio }] of estados) if (completo ? clave !== vacio : cambio > since) agentes[id] = datos;
    return { version, completo, agentes };
  };
  return {
    marca(agentId) {
      const datos = lee(agentId);
      const clave = JSON.stringify(datos);
      if ((estados.get(agentId)?.clave ?? vacio) === clave) return;
      estados.set(agentId, { datos, clave, cambio: ++version });
      for (const sigue of [...esperando]) sigue();
    },
    async espera(since) {
      if (since >= inicio && version <= since && !cerrada) {
        await new Promise<void>((sigue) => {
          const fin = () => {
            clearTimeout(limite);
            esperando.delete(fin);
            sigue();
          };
          const limite = setTimeout(fin, retencionMs);
          esperando.add(fin);
        });
      }
      return responde(since);
    },
    cierra() {
      cerrada = true;
      for (const sigue of [...esperando]) sigue();
    },
  };
}

/** One non-recursive inotify watch on a directory another process writes into (the pairs registry, the plan anchors).
 * shortcut: a directory that does not exist when the plugin starts is not watched until it restarts; watch its parent if that happens. */
export function observa(dir: string, cambio: (nombre: string | null) => void): FSWatcher | null {
  try {
    const vigilante = watch(dir, (_evento, nombre) => cambio(nombre ? String(nombre) : null));
    vigilante.on("error", (error) => console.warn(`suggest: deja de vigilar ${dir}: ${error.message}`));
    return vigilante;
  } catch (error) {
    console.warn(`suggest: no puede vigilar ${dir}: ${(error as Error).message}`);
    return null;
  }
}
