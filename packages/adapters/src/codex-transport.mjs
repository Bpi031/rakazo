import { setTimeout as sleep } from "node:timers/promises";
import { MAX_FRAME_BYTES } from "./codex-protocol.mjs";

export async function openComputerRuntime(base, token, computer, request, context, fetcher = fetch) {
  if (computer.kind !== "docker" || !context.userId || !context.spaceId || !context.botId
      || computer.botId !== context.botId
      || request.runId !== context.runId || request.runtime !== "codex") throw new Error("Invalid runtime computer scope");
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json",
    "x-rakazo-bot-id": computer.botId, "x-rakazo-space-id": context.spaceId,
    "x-rakazo-user-id": context.userId, "x-rakazo-run-id": request.runId };
  const root = `${base.replace(/\/$/, "")}/computers/${encodeURIComponent(computer.id)}/agent-sessions`;
  let closed = false, poll = false;
  const call = async (url, method, body, signal = context.signal) => {
    const response = await fetcher(url, { method, headers, redirect: "error", signal: AbortSignal.any([
      ...(signal ? [signal] : []), AbortSignal.timeout(15000)]),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Computer runtime request failed: ${response.status}`); }
    const reader = response.body?.getReader(); let bytes = 0; const chunks = [];
    if (!reader) throw new Error("Empty computer runtime response");
    try {
      while (true) { const item = await reader.read(); if (item.done) break;
        bytes += item.value.length;
        if (bytes > MAX_FRAME_BYTES) { await reader.cancel(); throw new Error("Computer runtime response exceeds cap"); }
        chunks.push(Buffer.from(item.value)); }
    } finally { reader.releaseLock(); }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
  const started = await call(root, "POST", request);
  if (typeof started.id !== "string" || !/^[a-f0-9-]{36}$/.test(started.id)) throw new Error("Invalid computer session identity");
  const url = `${root}/${started.id}`;
  return {
    async send(message) {
      if (closed) throw new Error("Computer runtime input session is closed");
      const bytes = Buffer.byteLength(JSON.stringify(message));
      if (bytes > MAX_FRAME_BYTES / 2) throw new Error(`ROST_RUNTIME_INPUT_FRAME_LIMIT: ${bytes} bytes exceeds ${MAX_FRAME_BYTES / 2}. Use bounded tool summaries/pages; inspect owned job state before retrying. No automatic numerical retry occurred.`);
      await call(url, "POST", message);
    },
    messages: {
      async *[Symbol.asyncIterator]() {
        if (poll) throw new Error("Runtime transport has a single consumer"); poll = true;
        let cursor = 0;
        while (!closed) {
          const result = await call(`${url}?after=${cursor}`, "GET");
          if (!Array.isArray(result.events) || result.events.length > 128) throw new Error("Invalid runtime event batch");
          for (const event of result.events) {
            if (event.sequence !== cursor + 1 || !event.message || typeof event.message !== "object") throw new Error("Runtime event sequence drift");
            cursor = event.sequence; yield event.message;
          }
          if (result.error) throw new Error("Computer runtime failed");
          if (result.closed) return;
          if (!result.events.length) await sleep(100, undefined, { signal: context.signal });
        }
      },
    },
    async close() {
      if (closed) return; closed = true;
      // Cleanup must still run after the caller's turn signal was cancelled.
      await call(url, "DELETE", undefined, AbortSignal.timeout(10000));
    },
  };
}
