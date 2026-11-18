import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { loadPinnedComputers, PinnedComputers } from "./pinned-computers.js";

const pin = { botId: "manager-test", containerId: "a".repeat(64), hostname: "manager-test",
  networkName: "test-private-network", macAddress: "02:00:00:00:00:01", ipv4Address: "172.25.0.5" };
const config = () => ({ schema: "rost/pinned-computers/v1", computers: [{ ...pin }] });
const inspect = () => ({ Id: pin.containerId,
  Config: { Hostname: pin.hostname, Labels: { "rost.role": "manager" } },
  HostConfig: { NetworkMode: pin.networkName }, State: { Running: true },
  NetworkSettings: { Networks: { [pin.networkName]: { MacAddress: pin.macAddress, IPAddress: pin.ipv4Address } } },
}) as unknown as Docker.ContainerInspectInfo;

describe("operator-pinned manager identities", () => {
  it("leaves unconfigured member lifecycle unchanged", () => {
    const pins = new PinnedComputers(config());
    expect(pins.has("member")).toBe(false);
    expect(pins.retainsNetwork("other-network")).toBe(false);
    expect(pins.connectOptions("member", "member-id", "other-network")).toEqual({ Container: "member-id" });
    expect(() => pins.assertReplacementAllowed("member")).not.toThrow();
  });
  it("pins reconnect options and retains the stopped manager network", () => {
    const pins = new PinnedComputers(config());
    expect(pins.retainsNetwork(pin.networkName)).toBe(true);
    expect(pins.connectOptions(pin.botId, pin.containerId, pin.networkName)).toEqual({
      Container: pin.containerId, EndpointConfig: { MacAddress: pin.macAddress, IPAMConfig: { IPv4Address: pin.ipv4Address } },
    });
    expect(() => pins.assertReplacementAllowed(pin.botId)).toThrow(/cannot be automatically replaced/);
  });
  it("accepts the exact running identity and permits a stopped endpoint to reconnect", () => {
    const pins = new PinnedComputers(config());
    const info = inspect();
    expect(() => pins.assertContainer(pin.botId, info, pin.networkName)).not.toThrow();
    info.State.Running = false; info.NetworkSettings.Networks = {};
    expect(() => pins.assertContainer(pin.botId, info, pin.networkName)).not.toThrow();
  });
  it.each(["container", "hostname", "role", "network", "extra-network", "mac", "ip", "missing-endpoint"])(
    "rejects %s drift without repairing or replacing it", (kind) => {
      const pins = new PinnedComputers(config()); const info = inspect();
      if (kind === "container") info.Id = "b".repeat(64);
      if (kind === "hostname") info.Config.Hostname = "different";
      if (kind === "role") info.Config.Labels["rost.role"] = "member";
      if (kind === "network") info.HostConfig.NetworkMode = "other";
      if (kind === "extra-network") info.NetworkSettings.Networks.other = { ...info.NetworkSettings.Networks[pin.networkName]! };
      if (kind === "mac") info.NetworkSettings.Networks[pin.networkName]!.MacAddress = "02:00:00:00:00:02";
      if (kind === "ip") info.NetworkSettings.Networks[pin.networkName]!.IPAddress = "172.25.0.6";
      if (kind === "missing-endpoint") info.NetworkSettings.Networks = {};
      expect(() => pins.assertContainer(pin.botId, info, pin.networkName)).toThrow(/Pinned manager/);
    });
  it("rejects reconnecting a different container or network", () => {
    const pins = new PinnedComputers(config());
    expect(() => pins.connectOptions(pin.botId, "b".repeat(64), pin.networkName)).toThrow();
    expect(() => pins.connectOptions(pin.botId, pin.containerId, "other")).toThrow();
  });
  it("rejects malformed or duplicate operator identities", () => {
    for (const patch of [{ macAddress: "01:00:00:00:00:01" }, { macAddress: "00:00:00:00:00:00" },
      { ipv4Address: "bad" }, { containerId: "short" }, { botId: "../other" }, { unexpected: true }])
      expect(() => new PinnedComputers({ ...config(), computers: [{ ...pin, ...patch }] })).toThrow();
    expect(() => new PinnedComputers({ ...config(), computers: [pin, pin] })).toThrow();
  });
  it("loads a protected file and rejects missing, writable or symbolic files", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "pinned-computers-"));
    try {
      const file = path.join(dir, "identities.json");
      writeFileSync(file, JSON.stringify(config()), { mode: 0o600 });
      expect(loadPinnedComputers(file).has(pin.botId)).toBe(true);
      const link = path.join(dir, "link.json"); symlinkSync(file, link);
      expect(() => loadPinnedComputers(link)).toThrow();
      chmodSync(file, 0o666); expect(() => loadPinnedComputers(file)).toThrow();
      expect(() => loadPinnedComputers(path.join(dir, "missing"))).toThrow();
      expect(() => loadPinnedComputers("relative.json")).toThrow();
      expect(() => loadPinnedComputers("")).toThrow();
      chmodSync(file, 0o600); writeFileSync(file, " ".repeat(65537));
      expect(() => loadPinnedComputers(file)).toThrow();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
