// Client de consola: la misma sugerencia de siguiente mensaje que el plugin de Paseo — el mismo servicio
// `sugiere` del clúster, el mismo cuerpo de petición, sin instrucción propia (es solo del servicio, como en el plugin).
// Solo cambia la parte visual: el hook `Stop` de Claude Code la muestra como systemMessage en el terminal en lugar
// de la píldora del composer. Silencioso por diseño, como el plugin: sin transcript, sin modelo real o servicio
// mudo no hay salida y la sesión no se bloquea.
import { readFileSync } from "node:fs";
import { transcriptMessages } from "../shared/transcript.ts";

// Presupuesto del hook: el servicio puede tardar (espera al residente); si pasa, esta vuelta no hay sugerencia.
const WAIT_MS = 25_000;

async function readStdin(): Promise<string> {
  const partes: Buffer[] = [];
  for await (const trozo of process.stdin) partes.push(trozo as Buffer);
  return Buffer.concat(partes).toString("utf8");
}

async function main(): Promise<void> {
  const hook = JSON.parse((await readStdin()) || "{}") as { session_id?: string; transcript_path?: string };
  if (!hook.transcript_path) return;
  let lines: string[];
  try {
    lines = readFileSync(hook.transcript_path, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return;
  }
  // Sin modelo real (sin turno del asistente, o solo `<synthetic>`) no hay nada que pedir (Dani 22-10, misma regla que el plugin).
  if (!transcriptMessages(lines).model) return;
  // Clave de auditoría y caché del servicio: nº de turno (lo que el plugin pasa como seq).
  const turno = lines.filter((l) => l.includes('"type":"user"')).length;
  const base = (process.env.SUGIERE_URL || "http://sugiere.llm.svc:8080").replace(/\/+$/, "");
  try {
    const res = await fetch(`${base}/v1/suggest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sid: hook.session_id ?? "consola",
        turno,
        transcript: lines.join("\n"),
        contexto: { kind: "live" },
      }),
      signal: AbortSignal.timeout(WAIT_MS),
    });
    if (!res.ok) return;
    const out = (await res.json().catch(() => ({}))) as { sugerencia?: unknown };
    const text = typeof out.sugerencia === "string" ? out.sugerencia.trim() : "";
    if (text) process.stdout.write(JSON.stringify({ systemMessage: `💡 Sugerencia: ${text}` }));
  } catch {
    // Servicio mudo o fuera de presupuesto: sin sugerencia, como en la ventana silenciosa del plugin.
  }
}

void main();
