export interface WebOrigins {
  webOrigin: string;
  additionalWebOrigins?: readonly string[];
}

export function parseAdditionalWebOrigins(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  const invalid = () =>
    new Error("WEB_ADDITIONAL_ORIGINS requires at most eight exact HTTP(S) origins");
  if (value.length > 4096) throw invalid();
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 8) throw invalid();
  for (const entry of entries) {
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      throw invalid();
    }
    if (!["http:", "https:"].includes(url.protocol) || url.origin !== entry || entry.includes("*"))
      throw invalid();
  }
  return [...new Set(entries)];
}

export function isAllowedWebOrigin(origin: string | undefined, env: WebOrigins): boolean {
  return (
    origin !== undefined &&
    [new URL(env.webOrigin).origin, ...(env.additionalWebOrigins ?? [])].includes(origin)
  );
}
