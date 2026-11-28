const legacyStatuses = ['reserved', 'preparing', 'running', 'stopping', 'completed', 'stopped', 'failed', 'recovery_required'];

/** Recognize only the known watcher validator; unrelated provider schemas stay untouched. */
export function rostWatchRunError(details: string): { summary: string; details: string } | null {
  let matched = details.trim().startsWith('ROST_JOB_WATCH_OBSERVATION:');
  if (!matched && details.length < 16000) {
    try {
      const issues: unknown = JSON.parse(details);
      matched = Array.isArray(issues) && issues.length === 1 && issues.every(issue =>
        issue?.code === 'invalid_value' && Array.isArray(issue.path) && issue.path.length === 1
        && issue.path[0] === 'status' && Array.isArray(issue.values)
        && issue.values.length === legacyStatuses.length
        && legacyStatuses.every(status => issue.values.includes(status)));
    } catch { /* Not this local watcher error. */ }
  }
  if (!matched) return null;
  return {
    summary: 'Rost job monitoring could not read the job status.',
    details: 'ROST_JOB_WATCH_OBSERVATION: This is a local monitoring error, not a model-provider failure. Check the existing owned job before continuing; it may still be running or already finished. Repair the watch without launching another solve. This error does not establish feasibility or infeasibility.',
  };
}
