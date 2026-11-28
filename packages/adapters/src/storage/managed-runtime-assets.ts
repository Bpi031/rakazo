import { readFileSync } from "node:fs";

export type ManagedRuntimeAsset =
  | "agent-report-reader.py"
  | "checkpoint-files.py"
  | "native-files.py"
  | "policy-amendment.py"
  | "policy-priority-helper.py"
  | "policy-relaxation.py"
  | "policy-workflow.py"
  | "rost-job-observer.py"
  | "workbench-files.py";

const loaded = new Map<ManagedRuntimeAsset, string>();

export function readManagedRuntimeAsset(name: ManagedRuntimeAsset): string {
  const cached = loaded.get(name);
  if (cached !== undefined) return cached;
  const source = readFileSync(
    new URL(import.meta.resolve(`@rakazo/adapters/runtime-assets/${name}`)),
    "utf8",
  );
  loaded.set(name, source);
  return source;
}
