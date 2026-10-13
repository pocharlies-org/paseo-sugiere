import type { PluginClientContext } from "@getpaseo/plugin/client";
import { addSuggestPill } from "./client/suggest-pill.ts";

export default function contribute(client: PluginClientContext) {
  return addSuggestPill(client);
}
