const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function managedReasoning(env = process.env) {
  const aliases = (env.CODEX_DEPLOYMENTS ?? "").split(",").map((id) => id.trim());
  const raw = env.CODEX_MODEL_REASONING ?? "{}";
  if (raw.length > 4096) throw new Error("Invalid operator reasoning configuration");
  const value = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 4)
    throw new Error("Invalid operator reasoning configuration");
  for (const [id, entry] of Object.entries(value)) {
    if (
      !aliases.includes(id) ||
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      Object.keys(entry).sort().join(",") !== "default,levels" ||
      !Array.isArray(entry.levels) ||
      !entry.levels.length ||
      entry.levels.length > EFFORTS.size ||
      new Set(entry.levels).size !== entry.levels.length ||
      entry.levels.some((level) => !EFFORTS.has(level)) ||
      !entry.levels.includes(entry.default)
    )
      throw new Error("Invalid operator reasoning configuration");
  }
  return value;
}

export function managedEffort(id, requested, configuration) {
  const entry = Object.hasOwn(configuration, id) ? configuration[id] : undefined;
  if (requested == null || requested === "") return entry?.default ?? null;
  if (!entry?.levels.includes(requested))
    throw new Error("Reasoning effort is not enabled for this model");
  return requested;
}
