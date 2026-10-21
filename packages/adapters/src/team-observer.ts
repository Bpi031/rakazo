export async function observeTeamComputers(computers: Array<{ id: string; botId: string; spaceId: string }>) {
  if (computers.length > 200) throw new Error("Observation limit exceeded");
  const url = process.env.SANDBOX_SUPERVISOR_URL;
  const token = process.env.SANDBOX_SUPERVISOR_TOKEN;
  if (!url || !token) throw new Error("Protected supervisor unavailable");
  const deadline = Date.now() + 8_000;
  const rows: Array<Record<string, unknown>> = new Array(computers.length);
  let next = 0;
  async function worker() {
    while (next < computers.length) {
      const index = next++; const computer = computers[index]!;
      try {
        const remaining = deadline - Date.now(); if (remaining <= 0) throw new Error("Deadline");
        const response = await fetch(url!.replace(/\/$/, "") + "/computers/" + encodeURIComponent(computer.id) + "/team-observation", {
          headers: { authorization: "Bearer " + token, "x-rakazo-bot-id": computer.botId, "x-rakazo-space-id": computer.spaceId },
          signal: AbortSignal.timeout(Math.min(remaining, 5_000)), redirect: "error" });
        if (!response.ok) throw new Error("Unavailable");
        const reader = response.body?.getReader(); if (!reader) throw new Error("Empty");
        let size = 0; const parts: Uint8Array[] = [];
        try { while (true) { const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength; if (size > 65536) { await reader.cancel(); throw new Error("Oversized"); } parts.push(value);
        } } finally { reader.releaseLock(); }
        rows[index] = JSON.parse(Buffer.concat(parts).toString("utf8"));
      } catch { rows[index] = { id: computer.id, available: false, jobsKnown: false, reason: "observation_unavailable" }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, computers.length) }, worker));
  return rows;
}
