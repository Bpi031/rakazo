import { randomUUID, createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { StringDecoder } from "node:string_decoder";

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_SESSIONS = 32;
const MAX_AGE_MS = 30 * 60 * 1000;
const ALLOWED = new Set(["initialize", "initialized", "thread/start", "turn/start", "turn/interrupt", "turn/steer"]);
const NATIVE_ALLOWED = new Set([...ALLOWED,'model/list','skills/list','configRequirements/read','thread/resume','thread/fork','thread/compact/start','review/start','fs/watch','fs/unwatch']);

export class SessionQueue {
  constructor() { this.events = []; this.bytes = 0; this.sequence = 0; this.ack = 0; this.closed = false; }
  push(message) {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > MAX_BYTES / 2 || this.bytes + bytes > MAX_BYTES || this.events.length >= 4096) throw new Error("Agent session queue exceeded finite cap");
    this.bytes += bytes; this.events.push({ sequence: ++this.sequence, message, bytes });
  }
  read(after) {
    if (!Number.isSafeInteger(after) || after < this.ack || after > this.sequence) throw new Error("Invalid session acknowledgement");
    this.ack = after;
    while (this.events[0]?.sequence <= after) this.bytes -= this.events.shift().bytes;
    const batch = []; let bytes = 0;
    for (const event of this.events) {
      if (batch.length >= 128 || bytes + event.bytes > MAX_BYTES / 2) break;
      bytes += event.bytes; batch.push({ sequence: event.sequence, message: event.message });
    }
    return { events: batch, closed: this.closed && batch.length === this.events.length, error: this.error === true };
  }
}

function identity(c) {
  const value = [c.req.param("id"), c.req.header("x-rakazo-bot-id"), c.req.header("x-rakazo-space-id"),
    c.req.header("x-rakazo-user-id"), c.req.header("x-rakazo-run-id")];
  if (value.some((x) => typeof x !== "string" || !x || x.length > 256)) throw new Error("Missing runtime scope");
  return JSON.stringify(value);
}

export function mountCodexSessions(app, { managedContainer, docker, env = process.env }) {
  const sessions = new Map(); const creating = new Set();
  const find = (c) => {
    const record = sessions.get(c.req.param("session"));
    if (!record || record.identity !== identity(c)) throw new Error("Unknown agent session");
    return record;
  };
  const fail = (c) => c.json({ error: "Agent session unavailable or invalid" }, 400);
  const root = "/computers/:id/agent-sessions";
  app.post(root, async (c) => {
    let stream, timer, record, id, scope, owner;
    try {
      scope = identity(c);
      owner = c.req.param("id");
      const body = await c.req.json();
      const native=body.native;
      const expectedKey=createHash('sha256').update(JSON.stringify({botId:c.req.header('x-rakazo-bot-id'),kind:'native_session',spaceId:c.req.header('x-rakazo-space-id'),userId:c.req.header('x-rakazo-user-id')})).digest('hex');
      if(native&&(env.ROST_AGENT_NATIVE!=='1'||Object.keys(native).sort().join(',')!=='key,lane,version'||native.version!==1||native.key!==expectedKey||!['main','helper'].includes(native.lane)))throw new Error('Invalid native scope');
      const peers=[...sessions.values()].filter(r=>r.owner===owner&&!r.queue.closed);
      const lock=native?.lane==='helper'?owner+':helper:'+body.runId:owner;
      if(sessions.size+creating.size>=MAX_SESSIONS||creating.has(lock)||
        (native?.lane==='helper'?(peers.filter(r=>r.lane==='helper').length>=2||!peers.some(r=>r.identity===scope&&r.lane==='main')):peers.length>0))throw new Error('Computer already owns a session');
      creating.add(lock); owner=lock;
      if (Object.keys(body).sort().join(",") !== (native?"capability,inferenceBaseUrl,model,native,runId,runtime":"capability,inferenceBaseUrl,model,runId,runtime")
          || body.runtime !== "codex" || body.runId !== c.req.header("x-rakazo-run-id")
          || body.inferenceBaseUrl !== env.CODEX_INFERENCE_BASE_URL
          || !(env.CODEX_DEPLOYMENTS ?? "").split(",").includes(body.model)
          || typeof body.capability !== "string" || body.capability.length > 4096) throw new Error("Invalid session configuration");
      const { container, info } = await managedContainer(c.req.param("id"), c.req.header("x-rakazo-bot-id"), c.req.header("x-rakazo-space-id"));
      if (!info.State.Running) throw new Error("Computer is not running");
      if (!env.CODEX_GATEWAY_CONTAINER) throw new Error("Inference gateway attachment is not configured");
      const gateway = await docker.getContainer(env.CODEX_GATEWAY_CONTAINER).inspect();
      if (gateway.Config.Labels?.["rost.inference-gateway"] !== "true") throw new Error("Unverified inference gateway");
      for (const [name, network] of Object.entries(info.NetworkSettings.Networks ?? {})) {
        if (name.startsWith("rakazo-computer-") && !gateway.NetworkSettings.Networks?.[name]) {
          try { await docker.getNetwork(network.NetworkID).connect({ Container: gateway.Id,
            EndpointConfig: { Aliases: ["rost-inference"] } }); }
          catch { const live = await docker.getContainer(gateway.Id).inspect();
            if (!live.NetworkSettings.Networks?.[name]) throw new Error("Gateway network attachment failed"); }
        }
      }
      const role = info.Config.Labels?.["rost.role"] ?? (env.TEAM_MANAGEMENT_ENABLED === "1" ? undefined : "manager");
      if (!["manager", "member"].includes(role)) throw new Error("Unverified computer role");
      const exec = await container.exec({ Cmd: ["/opt/office-python/bin/python3", "-I", "/opt/team/runtime/codex_session.py"],
        User: "1000:1000", WorkingDir: "/home/rakazo", AttachStdin: true, AttachStdout: true, AttachStderr: true,
        Env: [`CODEX_MODEL=${body.model}`, `CODEX_INFERENCE_BASE_URL=${body.inferenceBaseUrl}`,
          `CODEX_RUN_CAPABILITY=${body.capability}`, `TEAM_COMPUTER_ROLE=${role}`, "HOME=/home/rakazo",
          ...(native?[`ROST_NATIVE_KEY=${native.key}`,`ROST_NATIVE_LANE=${native.lane}`]:[]),
          "PATH=/opt/office-python/bin:/usr/local/bin:/usr/bin:/bin",
          ...(role === "manager" && native?.lane !== 'helper' ? ["ROST_RUNTIME_PYTHON=/opt/rost-python/bin/python3", "ROST_AGENT_SKILL_DIR=/opt/rost/skills/rost",
          "GRB_LICENSE_FILE=/run/rost-license/gurobi.lic", "GUROBI_THREADS=0"] : [])] });
      stream = await exec.start({ hijack: true, stdin: true });
      const queue = new SessionQueue(); id = randomUUID();
      record = { identity: scope, owner:c.req.param('id'), lane:native?.lane??'main', native:!!native, queue, stream, touched: Date.now(), decoder: new StringDecoder("utf8"), text: "" };
      sessions.set(id, record);
      const output = new PassThrough(); const errors = new PassThrough();
      const terminate = () => {
        queue.closed = true; stream.end(); stream.destroy();
        if(record.lane==='main') for(const [childId,child] of sessions) {
          if(child.identity===record.identity&&child.lane==='helper') {
            child.terminate(); clearTimeout(child.timer); sessions.delete(childId);
          }
        }
      };
      record.terminate = terminate;
      output.on("data", (data) => {
        try {
          record.text += record.decoder.write(data);
          let newline;
          while ((newline = record.text.indexOf("\n")) !== -1) {
            const line = record.text.slice(0, newline); record.text = record.text.slice(newline + 1);
            if (line.trim()) queue.push(JSON.parse(line));
          }
          if (Buffer.byteLength(record.text) > MAX_BYTES / 2) throw new Error("Oversized Codex frame");
        } catch { queue.error = true; terminate(); }
      });
      // Never publish raw stderr: it can contain credentials, prompts or provider bodies.
      errors.on("data", () => {});
      stream.on("end", () => { if (record.text.trim()) queue.error = true; terminate(); });
      stream.on("error", () => { queue.error = true; terminate(); });
      docker.modem.demuxStream(stream, output, errors);
      timer = setTimeout(() => { queue.error = true; terminate(); sessions.delete(id); }, MAX_AGE_MS);
      timer.unref(); record.timer = timer;
      return c.json({ id });
    } catch { if (stream) { stream.end(); stream.destroy(); } if (id) sessions.delete(id); if (timer) clearTimeout(timer); return fail(c); }
    finally { if (owner) creating.delete(owner); }
  });
  app.get(`${root}/:session`, (c) => {
    try { const record = find(c); record.touched = Date.now(); return c.json(record.queue.read(Number(c.req.query("after")))); }
    catch { return fail(c); }
  });
  app.post(`${root}/:session`, async (c) => {
    try {
      const record = find(c); const message = await c.req.json();
      if (record.queue.closed || !message || typeof message !== "object" || Array.isArray(message)
          || Buffer.byteLength(JSON.stringify(message)) > MAX_BYTES / 2
          || (message.method !== undefined && !(record.native?NATIVE_ALLOWED:ALLOWED).has(message.method))) throw new Error("Invalid input");
      if(record.native&&message.method==='fs/watch'&&message.params?.path!=='/home/rakazo/workspace')throw new Error('Watch escapes private workspace');
      if(record.native&&['thread/resume','thread/fork'].includes(message.method)&&(['path','history','config'].some(k=>k in (message.params??{}))||(message.params?.cwd!==undefined&&message.params.cwd!=='/home/rakazo')))throw new Error('Unsafe native resume override');
      if (message.method === undefined && message.id === undefined) throw new Error("Missing message identity");
      if (!record.stream.write(`${JSON.stringify(message)}\n`)) await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Backpressure timeout")), 5000);
        record.stream.once("drain", () => { clearTimeout(timeout); resolve(); });
      });
      return c.json({ ok: true });
    } catch { return fail(c); }
  });
  app.delete(`${root}/:session`, (c) => {
    try { const record = find(c); record.terminate(); clearTimeout(record.timer); sessions.delete(c.req.param("session")); return c.json({ ok: true }); }
    catch { return fail(c); }
  });
  return sessions;
}
