import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addSuggestPill } from "./client/suggest-pill.tsx";

export default function contribute(client: PluginClientContext) {
  return addSuggestPill(client);
}
