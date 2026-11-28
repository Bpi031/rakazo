const modelReplies = new Map([
  ["ROST_MODEL_OUTPUT_LIMIT", "The model reached its output limit before finishing."],
  ["ROST_MODEL_RESPONSE_FILTERED", "The model service did not deliver a complete reply."],
  ["ROST_MODEL_RESPONSE_INVALID", "The model service returned a reply Rost could not use."],
  ["ROST_MODEL_UNAVAILABLE", "Rost's model service is temporarily unavailable."],
  ["ROST_MODEL_CONTEXT_LIMIT", "This request is too large for the model."],
]);

/** Classify managed Codex failures without exposing raw diagnostics. */
export function nativeRunError(details: string): { summary: string; details: string } | null {
  const [code = ""] = details.trim().split(":", 1);
  const summary = modelReplies.get(code);
  if (summary) {
    return {
      summary,
      details:
        "No automatic retry or model change was made. Check any existing roster job before continuing.",
    };
  }
  if (
    details.trim() !== "Native session already owned" &&
    !details.trim().startsWith("ROST_NATIVE_SESSION_BUSY:")
  )
    return null;
  return {
    summary: "Another agent turn was using this private session.",
    details:
      "ROST_NATIVE_SESSION_BUSY: Rakazo prevented overlapping agent turns. Check the current chat and owned job before continuing. This is not a model-provider failure and does not mean the roster solve failed.",
  };
}
