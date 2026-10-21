import { execFileSync } from "node:child_process";

const paths = execFileSync("git", ["ls-files", "-z", "--cached"], {encoding: "utf8"})
  .split("\0").filter(Boolean);
const blocked = paths.filter((file) => {
  const parts = file.split("/");
  const name = parts.at(-1);
  return parts.some((part) => ["node_modules", ".pnpm-store", ".ssh"].includes(part))
    || /\.(?:lic|pem|key|p12|pfx)(?:\.|$)/i.test(name)
    || (/^\.env(?:\.|$)/.test(name) && !name.endsWith(".example"))
    || name === "authorized_keys"
    || (name === "auth.json" && parts.includes(".codex"))
    || /^(?:secrets|operator|workspace|workspaces|client|outputs|evidence)\//.test(file)
    || /(?:^|\/)(?:gurobi.*\.(?:tar|tgz|pkg|so|dylib|dll)|libgurobi[^/]*|c_export_chunks)(?:\/|$)/i.test(file);
});
if (blocked.length) {
  console.error("Repository contains forbidden credential, license, private-data or build paths:");
  for (const file of blocked) console.error(file);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({status: "passed", trackedPaths: paths.length,
    contentScanRequired: true, note: "Also run Gitleaks; filename checks do not detect embedded credentials"}));
}
