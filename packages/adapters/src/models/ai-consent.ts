import { createHash } from "node:crypto";
import type { AiDataUse, AiRecipient } from "@rakazo/contracts";
import { localBaseUrl } from "../runtime/pi/models/pi-local-provider.js";
import { listPiCatalog } from "../runtime/pi/models/pi-models.js";
import { voiceCatalogEntry } from "../voice/voice-factory.js";

const PRIVACY_URLS: Record<string, string> = {
  cursor: "https://cursor.com/privacy",
  openrouter: "https://openrouter.ai/privacy",
  openai: "https://openai.com/policies/privacy-policy/",
  "openai-codex": "https://openai.com/policies/privacy-policy/",
  anthropic: "https://www.anthropic.com/legal/privacy",
  google: "https://policies.google.com/privacy",
  "vercel-ai-gateway": "https://vercel.com/legal/privacy-policy",
  elevenlabs: "https://elevenlabs.io/privacy-policy",
  cartesia: "https://cartesia.ai/legal/privacy",
  "fish-audio": "https://fish.audio/privacy/",
  xai: "https://x.ai/legal/privacy-policy",
  supermemory: "https://supermemory.ai/privacy",
  honcho: "https://app.honcho.dev/privacy",
  hindsight: "https://vectorize.io/privacy",
  mnemoverse: "https://mnemoverse.com/docs/legal/privacy-policy",
};

/** Never expose endpoint paths, query parameters, user info, or credentials in a disclosure. */
export function aiRecipient(input: {
  provider: string;
  use: AiDataUse;
  baseUrl?: string;
  modelId?: string;
}): Omit<AiRecipient, "allowed"> | null {
  if (input.provider === "scripted") return null;
  const endpoint = input.baseUrl ?? (input.provider === "local" ? localBaseUrl() : undefined);
  const origin = endpoint ? new URL(endpoint).origin : undefined;
  const name =
    input.provider === "codex-foundry"
      ? managedRecipient(input.modelId)
      : recipientName(input.provider, input.use);
  // Ordinary model switches stay on an approved service; managed routes may change processor.
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        input.use,
        input.provider,
        endpoint ?? "",
        ...(input.provider === "codex-foundry" ? [input.modelId ?? "", name] : []),
      ]),
    )
    .digest("hex");
  return {
    key,
    name: origin ? `${name} (${origin})` : name,
    use: input.use,
    detail: ["openrouter", "vercel-ai-gateway"].includes(input.provider)
      ? "Forwards to model providers"
      : input.provider === "codex-foundry"
        ? (input.modelId ?? "")
        : "",
    privacyUrl: PRIVACY_URLS[input.provider],
  };
}

function recipientName(provider: string, use: AiDataUse) {
  if (use === "voice") return voiceCatalogEntry(provider)?.name ?? provider;
  if (use === "memory") {
    if (provider === "supermemory") return "Supermemory";
    if (provider === "honcho") return "Honcho";
    if (provider === "hindsight") return "Hindsight";
    if (provider === "mnemoverse") return "Mnemoverse";
    return provider;
  }
  if (provider === "cursor") return "Cursor";
  if (provider === "t3code") return "T3 Code";
  return listPiCatalog().find((entry) => entry.provider === provider)?.providerName ?? provider;
}

function managedRecipient(modelId?: string) {
  const value = JSON.parse(process.env.CODEX_MODEL_PROCESSORS ?? "{}");
  const name = modelId && value?.[modelId];
  if (name !== undefined && (typeof name !== "string" || !/^[A-Za-z0-9 ._()/-]{1,120}$/.test(name)))
    throw new Error("Invalid managed processor disclosure");
  return name || "Operator-managed service";
}
