import { PassThrough } from "node:stream";
import type Docker from "dockerode";
import type { Hono } from "hono";

export function mountTeamObservations(app: Hono, deps: {
  docker: Docker;
  managedContainer: (id: string, botId?: string, spaceId?: string) => Promise<{ container: Docker.Container; info: Docker.ContainerInspectInfo }>;
}) {
  app.get("/computers/:id/team-observation", async (c) => {
    try {
      const { container, info } = await deps.managedContainer(c.req.param("id"), c.req.header("x-rakazo-bot-id"), c.req.header("x-rakazo-space-id"));
      if (!info.State.Running) return c.json({ available: true, observedAt: new Date().toISOString(), running: false, cpuCores: 0, memoryBytes: 0, jobsKnown: true, solverJobs: [] });
      const stats = await container.stats({ stream: false });
      const delta = stats.cpu_stats.cpu_usage.total_usage - stats.precpu_stats.cpu_usage.total_usage;
      const system = stats.cpu_stats.system_cpu_usage - stats.precpu_stats.system_cpu_usage;
      const cores = stats.cpu_stats.online_cpus ?? stats.cpu_stats.cpu_usage.percpu_usage?.length;
      const cpuCores = system > 0 && delta >= 0 && cores ? delta / system * cores : null;
      let jobsKnown = false; let solverJobs: unknown[] = [];
      const exec = await container.exec({ Cmd: ["/opt/office-python/bin/python3", "-I", "/opt/team/runtime/process_probe.py"], User: "0:0", AttachStdout: true, AttachStderr: true });
      const stream = await exec.start({ hijack: true, stdin: false });
      const output = new PassThrough(); const errors = new PassThrough();
      let text = ""; let bytes = 0;
      const timer = setTimeout(() => stream.destroy(new Error("bounded process probe timed out")), 5000);
      try {
        deps.docker.modem.demuxStream(stream, output, errors);
        output.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > 65536) stream.destroy(new Error("process probe exceeded cap")); else text += chunk; });
        errors.resume();
        await new Promise<void>((resolve, reject) => { stream.once("end", resolve); stream.once("error", reject); });
        if ((await exec.inspect()).ExitCode === 0) { const result = JSON.parse(text); jobsKnown = result.jobsKnown === true; solverJobs = Array.isArray(result.solverJobs) ? result.solverJobs : []; }
      } finally { clearTimeout(timer); stream.destroy(); }
      return c.json({ available: true, observedAt: new Date().toISOString(), running: true, cpuCores,
        memoryBytes: stats.memory_stats.usage ?? null, memoryLimitBytes: stats.memory_stats.limit ?? null,
        jobsKnown, solverJobs });
    } catch { return c.json({ available: false, cpuCores: null, memoryBytes: null, jobsKnown: false, solverJobs: null }, 409); }
  });
}
