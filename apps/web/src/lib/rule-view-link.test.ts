import { expect, it } from "vitest";
import { ruleViewRoute } from "./rule-view-link";
it("opens only this bot's same-origin rules or exact review, stripping unrelated parameters", () => {
  expect(ruleViewRoute("/app/b?rules=current&path=/etc", "https://test", "b")).toBe("/app/b?rules=current");
  expect(ruleViewRoute("/app/b?priorityReview=12345678-abcd-abcd-abcd-123456789abc", "https://test", "b")).toContain("priorityReview=");
  for (const href of ["https://evil/app/b?rules=current","/app/other?rules=current","javascript:alert(1)","/app/b?priorityReview=not-a-review","/app/b?rules=other"]) expect(ruleViewRoute(href,"https://test","b")).toBeNull();
});
