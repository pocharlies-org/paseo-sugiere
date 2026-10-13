// The one HTTP client of the plugin: `node:http` and not fetch, because the fetch of Node adds `Sec-Fetch-Mode`, and the account service
// refuses every request that carries a `Sec-Fetch-*` header (it takes it for a page in a browser). This sends no `Origin` and no
// `Sec-Fetch-*`, and a `Host` of exactly host:port. One deadline for the whole exchange, and a cap on the size of the answer.
import { request } from "node:http";

export function send(
  to: { host: string; port: number },
  method: "GET" | "PATCH" | "POST",
  path: string,
  headers: Record<string, string>,
  body: string | undefined,
  timeoutMs: number,
  maxBytes: number,
): Promise<{ status: number; text: string }> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ ...to, method, path, headers, agent: false, signal: deadline.signal }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxBytes) req.destroy();
        else chunks.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("close", () => reject(new Error("closed"))); // after "end" the promise is settled: this only ends a cut answer
      res.on("error", reject);
    });
    req.on("error", reject);
    req.end(body);
  }).finally(() => clearTimeout(timer));
}
