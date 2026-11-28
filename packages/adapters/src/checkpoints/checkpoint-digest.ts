import { createHash } from "node:crypto";
import { callIdFromClientNonce } from "@rakazo/core";
import type { CheckpointBusiness } from "../storage/checkpoint-state.js";
import type { CheckpointFileManifest } from "./checkpoint-files.js";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}

/** Restore clones message identities; compare content and reply relationships instead. */
export function stateDigest(manifest: unknown, business: CheckpointBusiness) {
  const positions = new Map(business.transcript.map((message, index) => [message.id, index]));
  const binding = structuredClone(business.binding) as {
    selection?: Record<string, unknown>;
  } | null;
  if (binding?.selection) {
    binding.selection.policyApprovalGranted = false;
    binding.selection.solveStarted = false;
  }
  return createHash("sha256")
    .update(
      canonical({
        manifest,
        binding,
        artifacts: [...business.artifacts].sort((a, b) => a.id.localeCompare(b.id)),
        botInstructions: business.botInstructions,
        transcript: business.transcript.map((message) => ({
          role: message.role,
          blocks: message.blocks,
          botId: message.botId ?? null,
          authorUserId: message.authorUserId ?? null,
          runId: message.runId ?? null,
          callId: callIdFromClientNonce(message.clientNonce) ?? null,
          replyTo: message.replyToMessageId
            ? (positions.get(message.replyToMessageId) ?? null)
            : null,
          replyQuote: message.replyQuote ?? null,
          createdAt: new Date(message.createdAt).toISOString(),
        })),
      }),
    )
    .digest("hex");
}

export function checkpointFileDiff(before: CheckpointFileManifest, after: CheckpointFileManifest) {
  const a = new Map(before.entries.map((entry) => [entry.path, entry]));
  const b = new Map(after.entries.map((entry) => [entry.path, entry]));
  return {
    added: [...b.keys()].filter((path) => !a.has(path)),
    removed: [...a.keys()].filter((path) => !b.has(path)),
    changed: [...b.keys()].filter(
      (path) => a.has(path) && JSON.stringify(a.get(path)) !== JSON.stringify(b.get(path)),
    ),
  };
}
