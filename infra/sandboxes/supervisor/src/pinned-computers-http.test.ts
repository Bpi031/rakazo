import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { computerNetworkNameFor, hostComputerUser } from "./computer-spec.js";

const mocks = vi.hoisted(() => ({ docker: {
  version: vi.fn(), getImage: vi.fn(), getContainer: vi.fn(), listContainers: vi.fn(),
  createContainer: vi.fn(), createNetwork: vi.fn(), getNetwork: vi.fn(), listNetworks: vi.fn(),
}, home: vi.fn() }));
vi.mock("dockerode", () => ({ default: class { constructor() { return mocks.docker; } } }));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: mocks.home }));

const botId = "pinned-manager-test";
const containerId = "a".repeat(64);
const networkName = computerNetworkNameFor(botId);
let directory: string;
let info: any;
let container: any;
let network: any;
const headers = () => ({ authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
  "content-type": "application/json", "x-rakazo-bot-id": botId, "x-rakazo-space-id": "space" });

beforeEach(() => {
  vi.resetModules(); vi.resetAllMocks();
  directory = mkdtempSync(path.join(tmpdir(), "pinned-http-"));
  const configPath = path.join(directory, "identities.json");
  writeFileSync(configPath, JSON.stringify({ schema: "rost/pinned-computers/v1", computers: [{
    botId, containerId, hostname: "manager-test", networkName,
    macAddress: "02:00:00:00:00:01", ipv4Address: "172.25.0.5",
  }] }), { mode: 0o600 });
  vi.stubEnv("ROST_PINNED_COMPUTERS_FILE", configPath);
  vi.stubEnv("HOSTNAME", ""); vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_CONTROL_VIA_LOOPBACK", "false");
  vi.stubEnv("SANDBOX_COMPUTER_EGRESS", "open");
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "0"); vi.stubEnv("CODEX_DEPLOYMENTS", "");
  info = { Id: containerId, Image: "current-image", Config: { User: hostComputerUser(), Hostname: "manager-test",
    Labels: { "rakazo.managed": "true", "rakazo.botId": botId, "rakazo.spaceId": "space", "rost.role": "manager" } },
    HostConfig: { NetworkMode: networkName, PortBindings: {} }, State: { Running: false },
    NetworkSettings: { Networks: { [networkName]: { NetworkID: "network-id" } }, Ports: {} } };
  container = { id: containerId, inspect: vi.fn(async () => info), start: vi.fn(), stop: vi.fn(), remove: vi.fn() };
  network = { inspect: vi.fn(async () => ({ Id: "network-id", Containers: {} })),
    connect: vi.fn(async () => undefined), disconnect: vi.fn(), remove: vi.fn() };
  mocks.docker.getContainer.mockReturnValue(container);
  mocks.docker.listContainers.mockResolvedValue([{ Id: containerId }]);
  mocks.docker.getImage.mockReturnValue({ inspect: vi.fn(async () => ({ Id: "current-image" })) });
  mocks.docker.getNetwork.mockReturnValue(network);
  mocks.docker.createNetwork.mockResolvedValue(network);
});
afterEach(() => { vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

it("retains the pinned network after the normal stop endpoint", async () => {
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request(`/computers/${containerId}/stop`, { method: "POST", headers: headers() });
  expect(response.status).toBe(200);
  expect(network.disconnect).not.toHaveBeenCalled(); expect(network.remove).not.toHaveBeenCalled();
});

it("blocks UI deletion without removing the container", async () => {
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request(`/computers/${containerId}`, { method: "DELETE", headers: headers() });
  expect(response.status).toBe(409); expect(container.remove).not.toHaveBeenCalled();
});

it("does not replace a pinned manager when an image update changes the desired image", async () => {
  mocks.docker.getImage.mockReturnValue({ inspect: vi.fn(async () => ({ Id: "new-image" })) });
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request("/computers", { method: "POST", headers: headers(),
    body: JSON.stringify({ botId, spaceId: "space", homePath: path.join(directory, "homes", botId) }) });
  expect(response.status).toBe(500);
  expect(container.remove).not.toHaveBeenCalled(); expect(mocks.docker.createContainer).not.toHaveBeenCalled();
});

it("restores explicit MAC and IP when a stopped endpoint must reconnect", async () => {
  info.NetworkSettings.Networks = {};
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request("/computers", { method: "POST", headers: headers(),
    body: JSON.stringify({ botId, spaceId: "space", homePath: path.join(directory, "homes", botId) }) });
  expect(response.status).toBe(200);
  expect(network.connect).toHaveBeenCalledWith({ Container: containerId,
    EndpointConfig: { MacAddress: "02:00:00:00:00:01", IPAMConfig: { IPv4Address: "172.25.0.5" } } });
  expect(container.start).toHaveBeenCalledOnce(); expect(mocks.docker.createContainer).not.toHaveBeenCalled();
});

it("keeps private member identity checks ahead of the pinned delete guard", async () => {
  const { supervisorApp } = await import("./index.js");
  const response = await supervisorApp.request(`/computers/${containerId}`, { method: "DELETE",
    headers: { ...headers(), "x-rakazo-space-id": "other-space" } });
  expect(response.status).toBe(404); expect(container.remove).not.toHaveBeenCalled();
});
