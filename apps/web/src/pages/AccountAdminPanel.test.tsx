// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountAdminPanel } from "./AccountAdminPanel";
import { accountAdminApi } from "./account-admin-api";
vi.mock("./account-admin-api", () => ({ accountAdminApi: vi.fn() }));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, variant, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => <input {...props} />,
  Label: (props: any) => <label {...props} />,
  Switch: ({ onCheckedChange, checked, ...props }: any) => (
    <input
      {...props}
      type="checkbox"
      role="switch"
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children }: any) => <div>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
}));
const view = {
  userId: "self",
  organizationId: "org",
  canAssignRoles: true,
  emailDelivery: false,
  registration: { enabled: false, allowlist: ["@example.test"], digest: "a".repeat(64) },
  members: [
    {
      userId: "self",
      name: "Owner",
      email: "owner@example.test",
      verified: true,
      role: "owner",
      state: "active",
      protected: true,
    },
    {
      userId: "member",
      name: "Member",
      email: "member@example.test",
      verified: true,
      role: "member",
      state: "active",
      protected: false,
    },
  ],
  invitations: [],
  reviews: [],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(accountAdminApi).mockImplementation(async (operation) =>
    operation === "view"
      ? structuredClone(view)
      : ({
          id: "review",
          digest: "b".repeat(64),
          action: { kind: "member_role", userId: "member", role: "admin" },
          status: "pending",
          expiresAt: "2099-01-01T00:00:00Z",
        } as any),
  );
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});
const render = async () => {
  await act(async () => root.render(<AccountAdminPanel />));
};
const button = (name: string) =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(name),
  )!;
async function value(selector: string, next: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, next);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it("a registration toggle is a draft until exact review and password confirmation", async () => {
  await render();
  await act(async () => host.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  expect(vi.mocked(accountAdminApi).mock.calls.filter(([op]) => op !== "view")).toHaveLength(0);
  await act(async () => button("Review changes").click());
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain("Public registration: Open");
  expect(button("Apply changes").disabled).toBe(true);
  await value('[aria-label="Account confirmation phrase"]', "APPLY REGISTRATION");
  await value('[aria-label="Admin account password"]', "current-password");
  await act(async () => button("Apply changes").click());
  expect(accountAdminApi).toHaveBeenCalledWith(
    "registration",
    expect.objectContaining({
      enabled: true,
      allowlist: ["@example.test"],
      phrase: "APPLY REGISTRATION",
      password: "current-password",
    }),
  );
  expect(host.querySelector('input[type="password"]')).toBeNull();
});
it("owner/self accounts stay locked and role changes create a review only", async () => {
  await render();
  expect(host.textContent).toContain("Owner · Protected");
  expect(
    host.querySelector<HTMLSelectElement>('[aria-label="Account state for Owner"]')!.disabled,
  ).toBe(true);
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Role for Member"]')!;
  await act(async () => {
    select.value = "admin";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(accountAdminApi).toHaveBeenCalledWith("propose", {
    action: { kind: "member_role", userId: "member", role: "admin" },
  });
  expect(vi.mocked(accountAdminApi).mock.calls.some(([op]) => op === "confirm")).toBe(false);
});
it("organization managers do not see deployment registration or role escalation controls", async () => {
  vi.mocked(accountAdminApi).mockResolvedValue({
    ...view,
    registration: null,
    canAssignRoles: false,
  });
  await render();
  expect(host.querySelector('[role="switch"]')).toBeNull();
  expect(host.querySelector<HTMLSelectElement>('[aria-label="Role for Member"]')!.disabled).toBe(
    true,
  );
  expect(host.querySelector('[aria-label="Invitation role"] option[value="admin"]')).toBeNull();
});
it.each(["member", "admin"] as const)("confirms a %s invitation with the intended safeguards", async (role) => {
  const action = { kind: "invite", email: "new@example.test", role };
  const digest = "b".repeat(64);
  vi.mocked(accountAdminApi).mockImplementation(async (operation) => {
    if (operation === "view") return structuredClone(view) as any;
    if (operation === "confirm") return { enrollmentToken: "invite-token" } as any;
    return { id: "review", digest, action, status: "pending", expiresAt: "2099-01-01T00:00:00Z" } as any;
  });
  await render();
  await value('[aria-label="Member email"]', action.email);
  const select = host.querySelector<HTMLSelectElement>('[aria-label="Invitation role"]')!;
  await act(async () => {
    select.value = role;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const form = host.querySelector('[aria-label="Member invitations"] form')!;
  await act(async () => form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
  expect(accountAdminApi).toHaveBeenCalledWith("propose", { action });
  const member = role === "member";
  expect(host.querySelector('[role="dialog"]')?.textContent).toContain(
    `Invite ${action.email} as ${member ? "Member" : "Manager"}?`,
  );
  const confirm = button(member ? "Confirm invite" : "Apply changes");
  expect(confirm.disabled).toBe(true);
  expect(accountAdminApi).not.toHaveBeenCalledWith("confirm", expect.anything());
  await value('[aria-label="Admin account password"]', "current-password");
  const confirmationField = '[aria-label="Account confirmation phrase"]';
  if (member) {
    expect(host.querySelector(confirmationField)).toBeNull();
  } else {
    expect(host.textContent).toContain("Managers can administer team members and bots.");
    expect(confirm.disabled).toBe(true);
    await value(confirmationField, "APPLY review");
  }
  await act(async () => confirm.click());
  expect(accountAdminApi).toHaveBeenCalledWith("confirm", {
    id: "review", digest, phrase: "APPLY review", password: "current-password",
  });
  expect(host.querySelector<HTMLTextAreaElement>("#private-invite-token")?.value).toBe("invite-token");
});
it("failed saves do not claim success or erase the review; password is cleared", async () => {
  await render();
  await act(async () => button("Review changes").click());
  await value('[aria-label="Account confirmation phrase"]', "APPLY REGISTRATION");
  await value('[aria-label="Admin account password"]', "current-password");
  vi.mocked(accountAdminApi).mockRejectedValue(new Error("Stale policy"));
  await act(async () => button("Apply changes").click());
  expect(host.querySelector('[role="alert"]')?.textContent).toBe("Stale policy");
  expect(host.querySelector<HTMLInputElement>('[aria-label="Admin account password"]')!.value).toBe(
    "",
  );
  expect(host.textContent).not.toContain("Account settings saved.");
});
