import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { locateSession } from "./session.ts";


type Paseo = PluginHandlerContext["paseo"];

const humano = (t: string): boolean => {
  const s = t.trim();
  return s !== "" && !s.startsWith("[") && !s.startsWith("<") && !s.startsWith("RETOMA:") && !s.startsWith("EVENTO:");
};

export async function objetivoDeAgente(agentId: string, paseo: Paseo): Promise<{ objetivo: string | null }> {
  try {
    // Read original user records: the flattened transcript also contains synthetic users and tool output.
    for (const line of (await locateSession(agentId, paseo)).reverse()) {
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.type !== "user" || event.isMeta || event.isCompactSummary || event.message?.role !== "user") continue;
      const content = event.message.content;
      if (Array.isArray(content) && content.some(b => b?.type === "tool_result")) continue;
      const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter(b => b?.type === "text").map(b => b.text).join("\n") : "";
      if (humano(text) && !/^(Tool loaded\.|Stop hook feedback:|Another Claude session sent a message:|\(supervisor;|This session is being continued)/.test(text.trim())) return { objetivo: text.trim().slice(0, 4000) };
    }
  } catch {
    // no-session / no-transcript / unreadable: el campo empieza vacío, como antes de que existiera el objetivo editable
  }
  return { objetivo: null };
}
