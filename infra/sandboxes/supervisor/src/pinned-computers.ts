import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import type Docker from "dockerode";
import { z } from "zod";

const identitySchema = z.object({
  botId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
  containerId: z.string().regex(/^[a-f0-9]{64}$/),
  hostname: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,62}$/),
  networkName: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/),
  macAddress: z.string().regex(/^(?:[a-f0-9]{2}:){5}[a-f0-9]{2}$/)
    .refine((value) => (parseInt(value.slice(0, 2), 16) & 1) === 0 && value !== "00:00:00:00:00:00"),
  ipv4Address: z.string().refine((value) => isIP(value) === 4),
}).strict();

const registrySchema = z.object({
  schema: z.literal("rost/pinned-computers/v1"),
  computers: z.array(identitySchema).max(64),
}).strict().superRefine(({ computers }, ctx) => {
  for (const field of ["botId", "containerId", "hostname", "networkName", "macAddress"] as const) {
    if (new Set(computers.map((item) => item[field])).size !== computers.length)
      ctx.addIssue({ code: "custom", message: `Duplicate pinned computer ${field}` });
  }
});

export class PinnedComputers {
  private readonly computers: z.infer<typeof identitySchema>[];

  constructor(value: unknown = { schema: "rost/pinned-computers/v1", computers: [] }) {
    this.computers = registrySchema.parse(value).computers;
  }

  has(botId: string): boolean {
    return this.computers.some((item) => item.botId === botId);
  }

  retainsNetwork(name: string): boolean {
    return this.computers.some((item) => item.networkName === name);
  }

  assertContainer(botId: string, info: Docker.ContainerInspectInfo, networkName: string | undefined) {
    const pin = this.computers.find((item) => item.botId === botId);
    if (!pin) return;
    if (info.Id !== pin.containerId || info.Config.Hostname !== pin.hostname ||
        info.Config.Labels?.["rost.role"] !== "manager" || networkName !== pin.networkName ||
        info.HostConfig.NetworkMode !== pin.networkName)
      throw new Error("Pinned manager identity changed; operator reconciliation required");
    const networks = info.NetworkSettings.Networks ?? {};
    if (Object.keys(networks).some((name) => name !== pin.networkName))
      throw new Error("Pinned manager has an unexpected network; operator reconciliation required");
    const endpoint = networks[pin.networkName];
    if (info.State.Running && (endpoint?.MacAddress !== pin.macAddress || endpoint?.IPAddress !== pin.ipv4Address))
      throw new Error("Pinned manager network identity changed; operator reconciliation required");
  }

  assertReplacementAllowed(botId: string) {
    if (this.has(botId))
      throw new Error("Pinned manager cannot be automatically replaced; operator reconciliation required");
  }

  connectOptions(botId: string, containerId: string, networkName: string): Docker.NetworkConnectOptions {
    const pin = this.computers.find((item) => item.botId === botId);
    if (!pin) return { Container: containerId };
    if (pin.containerId !== containerId || pin.networkName !== networkName)
      throw new Error("Pinned manager reconnect identity changed");
    return {
      Container: containerId,
      EndpointConfig: { MacAddress: pin.macAddress, IPAMConfig: { IPv4Address: pin.ipv4Address } },
    };
  }
}

export function loadPinnedComputers(file = process.env.ROST_PINNED_COMPUTERS_FILE): PinnedComputers {
  if (file === undefined) return new PinnedComputers();
  if (!file || !isAbsolute(file)) throw new Error("Pinned computers require an absolute operator file");
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536 || (stat.mode & 0o022) !== 0 ||
        (stat.uid !== 0 && stat.uid !== process.getuid?.()))
      throw new Error("Pinned computers require a bounded, protected operator file");
    const raw = readFileSync(fd, "utf8");
    if (Buffer.byteLength(raw) > 65536) throw new Error("Pinned computer registry exceeds size limit");
    return new PinnedComputers(JSON.parse(raw));
  } finally {
    closeSync(fd);
  }
}
