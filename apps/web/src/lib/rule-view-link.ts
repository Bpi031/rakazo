export function ruleViewRoute(href: string, origin: string, botId?: string): string | null {
  if (!botId) return null;
  try {
    const url = new URL(href, origin);
    if (url.origin !== origin || url.pathname !== "/app/" + botId || url.username || url.password) return null;
    if (url.searchParams.get("rules") === "current") return url.pathname + "?rules=current";
    const review = url.searchParams.get("priorityReview");
    return review && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(review) ?
      url.pathname + "?priorityReview=" + review : null;
  } catch { return null; }
}
