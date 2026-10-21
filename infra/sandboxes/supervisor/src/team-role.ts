import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export function mappedTeamHome(root: string, home: string) {
  if (process.env.TEAM_MANAGEMENT_ENABLED !== "1") return path.join(root, "homes", home);
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(home)) throw new Error("Invalid home identity");
  const name = createHash("sha256").update(home).digest("hex");
  const file = path.join(process.env.TEAM_STORAGE_MAPPINGS ?? "/run/rost-team-storage/mappings", name + ".json");
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022)) throw new Error("Untrusted home mapping");
  const data = JSON.parse(readFileSync(file, "utf8"));
  if (data.home !== home || !/^[a-f0-9]{64}$/.test(data.member)) throw new Error("Invalid home ownership");
  return path.join(root, "members", data.member, "homes", home);
}
