import assert from "node:assert/strict";
import { test } from "node:test";
import { forService, transcriptMessages } from "../shared/transcript.ts";

// What the plugin sends the service of a long session: the service reads only past the last compaction, and counts the user's
// own messages over the whole session (racha). Before the boundary only those survive; tool results, assistant turns and bad lines go.
test("forService keeps everything since the last compaction and only user text before it", () => {
  const l = (o: object) => JSON.stringify(o);
  const before = [
    l({ type: "user", message: { role: "user", content: "EVENTO: ci verde" } }),
    l({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] } }),
    l({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "y".repeat(1000) }] } }),
    l({ type: "user", message: { role: "user", content: [{ type: "text", text: "[AUTOPILOT] sigue" }] } }),
    "{cut",
  ];
  const after = [l({ type: "system", subtype: "compact_boundary" }), l({ type: "user", message: { role: "user", content: "resumen" } })];
  const out = forService([...before, ...after]);
  assert.deepEqual(out, [before[0], before[3], ...after]);
  assert.deepEqual(transcriptMessages(out).messages, transcriptMessages([...before, ...after]).messages, "the service reads the same");
  const plain = [before[0], before[1]];
  assert.deepEqual(forService(plain), plain, "no compaction: untouched");
});
