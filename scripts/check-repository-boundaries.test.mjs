import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-repository-boundaries.mjs", import.meta.url));
function check(paths) {
  const root = mkdtempSync(join(tmpdir(), "repository-boundary-"));
  try {
    execFileSync("git", ["init", "-q", root]);
    for (const path of paths) {
      const file = join(root, path);
      mkdirSync(dirname(file), {recursive: true});
      writeFileSync(file, "SYNTHETIC_BOUNDARY_FIXTURE\n");
    }
    execFileSync("git", ["-C", root, "add", "--all"]);
    return spawnSync(process.execPath, [script], {cwd: root, encoding: "utf8"});
  } finally {
    rmSync(root, {recursive: true, force: true});
  }
}

test("source, notices and empty configuration examples remain allowed", () => {
  const result = check(["src/main.ts", "LICENSE", "OPENBOT_LICENSE.txt", ".env.example", "deploy/.env.images.example"]);
  assert.equal(result.status, 0, result.stderr);
});

test("activation files, private keys and real environment paths are rejected", () => {
  for (const path of ["gurobi.lic", "nested/gurobi.lic.backup", ".env", ".env.production", "server.key", "identity.pem", "signing.p12", ".ssh/id_ed25519", ".codex/auth.json", "authorized_keys"])
    assert.equal(check([path]).status, 1, path);
});

test("private runtime directories, solver installers and build caches are rejected", () => {
  for (const path of ["secrets/api", "operator/login.json", "workspace/client.xlsx", "evidence/report.json", "outputs/roster.xlsx", "node_modules/package/file.js", ".pnpm-store/cache", "vendor/libgurobi.so", "vendor/gurobi1303.tar"])
    assert.equal(check([path]).status, 1, path);
});
