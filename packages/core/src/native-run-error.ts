/** Ownership contention is local orchestration, not a provider/API-key failure. */
export function nativeRunError(details: string): { summary: string; details: string } | null {
  if (details.trim() !== 'Native session already owned' && !details.trim().startsWith('ROST_NATIVE_SESSION_BUSY:')) return null;
  return {
    summary: 'Another agent turn was using this private session.',
    details: 'ROST_NATIVE_SESSION_BUSY: Rakazo prevented overlapping agent turns. Check the current chat and owned job before continuing. This is not a model-provider failure and does not mean the roster solve failed.',
  };
}
