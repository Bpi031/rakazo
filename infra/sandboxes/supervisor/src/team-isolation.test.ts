import { afterEach, expect, it, vi } from "vitest";
import { containerCreateOptions } from "./computer-spec.js";

afterEach(() => vi.unstubAllEnvs());
for (const role of ["manager", "member"] as const) it(`${role} uses only authorized mounts and bounded scratch`, () => {
  vi.stubEnv("TEAM_MANAGEMENT_ENABLED", "1");
  vi.stubEnv("CODEX_DEPLOYMENTS", "model");
  vi.stubEnv("ROST_GUROBI_LICENSE_HOST", "/srv/licenses/gurobi.lic");
  const spec = containerCreateOptions({ name: "test", image: "reviewed-" + role, botId: "bot", spaceId: "space", homePath: "/srv/data/member/home", role });
  expect(spec.Labels["rost.role"]).toBe(role);
  expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
  expect(spec.HostConfig.Tmpfs?.["/tmp"]).toContain("size=1g");
  expect(spec.HostConfig.Binds).toEqual(["/srv/data/member/home:/home/rakazo"]);
  const mounts = spec.HostConfig.Mounts ?? [];
  expect(mounts.some((mount) => mount.Target === "/var/run/docker.sock")).toBe(false);
  expect(mounts.some((mount) => mount.Target.includes("team-storage"))).toBe(false);
  expect(mounts.some((mount) => mount.Target === "/run/rost-license/gurobi.lic")).toBe(role === "manager");
  expect(spec.Env.find((value) => value.startsWith("PATH="))?.includes("/opt/gurobi")).toBe(role === "manager");
});
