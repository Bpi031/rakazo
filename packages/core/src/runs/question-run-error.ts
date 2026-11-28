/** Recognize legacy form failures narrowly; never render raw validator payloads. */
export function questionRunError(details: string): { summary: string; details: string } | null {
  let matched = details.trim().startsWith("ROST_QUESTION_INPUT_INVALID:");
  if (!matched && details.length < 64000) {
    try {
      const issues: unknown = JSON.parse(details);
      matched = Array.isArray(issues) && issues.length > 0 && issues.length <= 16 && issues.every(issue => {
        const path = issue?.path;
        return issue?.code === "too_big" && issue?.origin === "string" && issue?.maximum === 200
          && Array.isArray(path) && path.length === 3 && path[0] === "fields"
          && Number.isInteger(path[1]) && path[1] >= 0 && path[1] <= 2 && path[2] === "label";
      });
    } catch { /* Other errors retain their existing classification. */ }
  }
  if (!matched) return null;
  return {
    summary: "Rakazo could not display the question form. No answer was recorded.",
    details: "ROST_QUESTION_INPUT_INVALID: The generated question did not meet the form requirements. No choice or approval was recorded. Check existing work before continuing; do not restart a roster job to repair a question.",
  };
}
