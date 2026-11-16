// SC-5805: the ✦ learns what changed from one call per client that the server holds, never from a clock. What the pill paints
// for an agent is its `suggest.get` answer; this module remembers the last answer of every agent and the version at which it
// last changed, and answers a held call with only the asked agents that changed after the caller's version. Whatever can change
// an answer (a suggestion settling, a turn starting, «no es esto», the supervisor's pair registry, a plan anchor) calls `avisa`;
// the held calls then look again. The pattern of paseo-agentes' `panel.watch` (SC-5601).

const RETENCION_MS = 20_000; // a held call answers by then: under the daemon's 30 s plugin request timeout
const AVISO_MS = 300; // a burst (turns ending in many sessions, a registry rewrite) wakes the held calls once

export type Foto<T> = { agentes: Record<string, T>; version: number; completo: boolean };

export interface Vigia<T> {
  /** The asked agents whose answer changed after `since`: at once when there are some, else when one changes or the hold ends. */
  espera(agentes: readonly string[], since: number, lee: (agentes: readonly string[]) => Record<string, T>): Promise<Foto<T>>;
  /** Something that can change an answer happened: the held calls look again. */
  avisa(): void;
  cierra(): void;
}

export function vigia<T>(retencionMs = RETENCION_MS, avisoMs = AVISO_MS): Vigia<T> {
  // A `since` from before this instance (the plugin was reloaded) is older than its start: that caller gets everything again.
  const inicio = Date.now();
  let version = inicio;
  let cerrada = false;
  const vistas = new Map<string, { json: string; cambio: number }>();
  const esperando = new Set<() => void>();
  let aviso: ReturnType<typeof setTimeout> | null = null;
  const despierta = () => {
    aviso = null;
    for (const sigue of [...esperando]) sigue();
  };
  const retiene = (ms: number) =>
    new Promise<boolean>((sigue) => {
      const movida = () => {
        clearTimeout(limite);
        esperando.delete(movida);
        sigue(true);
      };
      const limite = setTimeout(() => {
        esperando.delete(movida);
        sigue(false);
      }, ms);
      esperando.add(movida);
    });
  // Synchronous: the version a caller gets already counts every change this read found.
  const foto = (pedidas: readonly string[], since: number, lee: (agentes: readonly string[]) => Record<string, T>): Foto<T> => {
    const completo = since < inicio || since > version;
    const agentes: Record<string, T> = {};
    for (const [id, respuesta] of Object.entries(lee(pedidas))) {
      const json = JSON.stringify(respuesta);
      let vista = vistas.get(id);
      if (vista?.json !== json) vistas.set(id, (vista = { json, cambio: ++version }));
      if (completo || vista.cambio > since) agentes[id] = respuesta;
    }
    return { agentes, version, completo };
  };
  return {
    async espera(pedidas, since, lee) {
      const hasta = Date.now() + retencionMs;
      let ultima = false;
      for (;;) {
        const r = foto(pedidas, since, lee);
        // When the hold ends it looks once more: a change nobody announced (a title, a file written while no watch) still arrives.
        if (r.completo || Object.keys(r.agentes).length > 0 || ultima || cerrada) return r;
        since = r.version; // what moved was other agents': keep holding from here
        const queda = hasta - Date.now();
        ultima = queda <= 0 || !(await retiene(queda));
      }
    },
    avisa() {
      if (!cerrada) aviso ??= setTimeout(despierta, avisoMs);
    },
    cierra() {
      cerrada = true;
      if (aviso) clearTimeout(aviso);
      despierta();
    },
  };
}
