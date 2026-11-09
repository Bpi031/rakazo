// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { TeamSettingsPanel } from "./TeamSettingsPanel";
import { teamApi } from "./team-api";

vi.mock("../lib/rpc", () => ({ selectSpace: vi.fn() }));
vi.mock("./team-api", () => ({ teamApi: vi.fn() }));
vi.mock("@rakazo/ui-web", () => ({
  Button: "button",
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: "div",
  DialogTitle: "h2",
}));

it.each(["member", "admin"] as const)("reviews a pending %s invite in Team settings", async (role) => {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const digest = "a".repeat(64);
  const review = {
    id: "team-review", digest, action: { kind: "invite", email: "new@example.test", role },
    status: "pending", expiresAt: "2099-01-01T00:00:00Z",
  };
  vi.mocked(teamApi).mockClear().mockImplementation(async (operation) => {
    if (operation === "overview") return { userId: "owner", manager: true, members: [] } as any;
    if (operation === "actions") return [review] as any;
    if (operation === "confirm") return { enrollmentToken: "invite-token" } as any;
    return [] as any;
  });
  const button = (name: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  async function fill(name: string, value: string) {
    const input = host.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  try {
    await act(async () => root.render(<TeamSettingsPanel />));
    await act(async () => button("Review exact action").click());
    const member = role === "member";
    const confirm = button(member ? "Confirm invite" : "Confirm action");
    expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
      `Invite new@example.test as ${member ? "Member" : "Manager"}?`,
    );
    expect(confirm.disabled).toBe(true);
    expect(teamApi).not.toHaveBeenCalledWith("confirm", expect.anything());
    await fill("Your account password", "current-password");
    if (member) {
      expect(host.querySelector('[aria-label="Exact confirmation phrase"]')).toBeNull();
    } else {
      expect(confirm.disabled).toBe(true);
      await fill("Exact confirmation phrase", "APPLY team-review");
    }
    await act(async () => confirm.click());
    expect(teamApi).toHaveBeenCalledWith("confirm", {
      id: "team-review", digest, phrase: "APPLY team-review", password: "current-password",
    });
    expect(host.textContent).toContain("invite-token");
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
});
