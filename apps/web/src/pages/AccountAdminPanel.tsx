import { useEffect, useState } from "react";
import type { AccountAdminView } from "@rakazo/contracts";
import { accountAdminViewSchema } from "@rakazo/contracts";
import { Button, Dialog, DialogContent, DialogTitle, Input, Label, OptionSelect, Switch } from "@rakazo/ui-web";
import { Check, MailPlus, RefreshCw, Save, ShieldCheck, X } from "lucide-react";
import { accountAdminApi } from "./account-admin-api";
import type { SaveScope } from "../lib/query/query";
import { useManagedOperation } from "../lib/query/use-managed-operation";
import { useBoundSpaceId } from "../lib/query/space-rpc";

type Review = {
  id: string;
  digest: string;
  action: Record<string, unknown>;
  expiresAt: string;
  status: string;
};
type RegistrationReview = { enabled: boolean; allowlist: string[]; digest: string };
const control = "min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-body";
const icon =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40";

export function AccountAdminPanel() {
  const [view, setView] = useState<AccountAdminView | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [admission, setAdmission] = useState("selected");
  const [emails, setEmails] = useState("");
  const [query, setQuery] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [registrationReview, setRegistrationReview] = useState<RegistrationReview | null>(null);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const write = useManagedOperation();
  const busy = write.pending;
  const activeSpaceId = useBoundSpaceId();

  async function load(signal?: AbortSignal, spaceId = activeSpaceId, isCurrent = () => true) {
    const next = accountAdminViewSchema.parse(await accountAdminApi("view", undefined, signal, spaceId));
    if (signal?.aborted || !isCurrent()) return;
    setView(next);
    if (next.registration) {
      setEnabled(next.registration.enabled);
      setAdmission(next.registration.allowlist.length ? "selected" : "anyone");
      setEmails(next.registration.allowlist.join("\n"));
    }
  }
  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal).catch(() => {
      if (!controller.signal.aborted) setError("Admin settings are unavailable for this account.");
    });
    return () => controller.abort();
  }, [activeSpaceId]);
  function work(action: (scope: SaveScope) => Promise<void>) {
    write.run(async (scope) => {
      setError("");
      setNotice("");
      setPassword("");
      try { await action(scope); }
      catch (error) {
        if (scope.isCurrent()) setError(error instanceof Error ? error.message : "Account operation failed.");
      }
    });
  }
  async function propose(action: Record<string, unknown>) {
    work(async (scope) => {
      const next = await accountAdminApi<Review>("propose", { action }, undefined, scope.spaceId);
      if (!scope.isCurrent()) return;
      setReview(next);
      setRegistrationReview(null);
      setPhrase("");
    });
  }
  function description(action: Record<string, unknown>) {
    const name = view?.members.find((member) => member.userId === action.userId)?.name ?? "Member";
    if (action.kind === "member_role") return `${name}: role → ${action.role}`;
    if (action.kind === "member_state") return `${name}: account → ${action.state}`;
    if (action.kind === "invite") return `Invite ${action.email} as ${action.role === "admin" ? "Manager" : "Member"}?`;
    return `Revoke invitation ${view?.invitations.find((invite) => invite.id === action.inviteId)?.email ?? ""}`;
  }
  const memberInvite = review?.action.kind === "invite" && review.action.role === "member";
  const managerInvite = review?.action.kind === "invite" && review.action.role === "admin";
  const confirmation = registrationReview
    ? "APPLY REGISTRATION"
    : review
      ? "APPLY " + review.id
      : "";
  function closeReview() {
    setReview(null);
    setRegistrationReview(null);
    setPassword("");
    setPhrase("");
  }
  return (
    <section className="min-w-0 space-y-6 py-2">
      <header className="flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-body-lg font-semibold">
          <ShieldCheck size={18} />
          Admin
        </h2>
        <button
          type="button"
          title="Refresh accounts"
          aria-label="Refresh accounts"
          className={icon}
          disabled={busy}
          onClick={() => work((scope) => load(undefined, scope.spaceId, scope.isCurrent))}
        >
          <RefreshCw size={17} />
        </button>
      </header>
      {error && (
        <p role="alert" className="break-words text-body text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-body">
          {notice}
        </p>
      )}
      {!view && !error && <p role="status">Loading accounts…</p>}
      {view?.registration && (
        <section
          className="space-y-4 border-b border-border pb-5"
          aria-label="Registration settings"
        >
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="public-registration">Public registration</Label>
            <Switch
              id="public-registration"
              checked={enabled}
              disabled={busy}
              onCheckedChange={setEnabled}
            />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Label htmlFor="registration-admission">Who can register</Label>
            <OptionSelect
              id="registration-admission"
              className={control}
              disabled={busy}
              value={admission}
              onValueChange={setAdmission}
              options={[
                { value: "anyone", label: "Anyone" },
                { value: "selected", label: "Selected emails / domains" },
              ]}
            />
          </div>
          {admission === "selected" && (
            <label className="block space-y-2 text-body">
              <span>Allowed emails / @domains</span>
              <textarea
                className={control + " w-full"}
                aria-label="Allowed registration emails"
                value={emails}
                rows={3}
                maxLength={16_000}
                onChange={(e) => setEmails(e.target.value)}
                disabled={busy}
              />
            </label>
          )}
          <div className="flex items-center justify-between gap-3">
            <span className="text-label text-muted-foreground">
              Current: {view.registration.enabled ? "Open" : "Closed"}
            </span>
            <Button
              variant="outline"
              disabled={busy || (admission === "selected" && !emails.trim())}
              onClick={() => {
                setReview(null);
                setRegistrationReview({
                  enabled,
                  allowlist:
                    admission === "anyone"
                      ? []
                      : [
                          ...new Set(
                            emails
                              .split(/[\n,]+/)
                              .map((s) => s.trim().toLowerCase())
                              .filter(Boolean),
                          ),
                        ],
                  digest: view.registration!.digest,
                });
                setPhrase("");
              }}
            >
              <Save size={15} />
              Review changes
            </Button>
          </div>
        </section>
      )}
      {view && (
        <>
          <section className="space-y-3" aria-label="Member accounts">
            <h3 className="text-body font-semibold">Member accounts</h3>
            <Input
              aria-label="Search member accounts"
              placeholder="Search members"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="max-w-full overflow-auto">
              <table className="w-full min-w-[580px] text-left text-body">
                <thead>
                  <tr>
                    {["Member", "Role", "Account"].map((title) => (
                      <th key={title} className="pb-2 pr-4 font-medium">
                        {title}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {view.members
                    .filter((member) =>
                      (member.name + " " + member.email)
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((member) => (
                      <tr key={member.userId} className="border-t border-border">
                        <td className="py-3 pr-4">
                          <p className="font-medium">
                            {member.name}
                            {member.userId === view.userId ? " (you)" : ""}
                          </p>
                          <p className="text-label text-muted-foreground">{member.email}</p>
                          <p className="text-label text-muted-foreground">
                            {member.verified ? "Verified" : "Email unverified"}
                          </p>
                        </td>
                        <td className="py-3 pr-4">
                          {member.role.split(",").some((role) => role.trim() === "owner") ? (
                            <span>Owner <span className="text-muted-foreground">Protected</span></span>
                          ) : (
                            <OptionSelect
                              className={control}
                              aria-label={"Role for " + member.name}
                              value={member.role.split(",").some((role) => role.trim() === "admin") ? "admin" : "member"}
                              disabled={busy || member.protected || !view.canAssignRoles}
                              onValueChange={(role) =>
                                void propose({
                                  kind: "member_role",
                                  userId: member.userId,
                                  role,
                                })
                              }
                              options={[{ value: "member", label: "Member" }, { value: "admin", label: "Manager" }]}
                            />
                          )}
                        </td>
                        <td className="py-3">
                          <OptionSelect
                            className={control}
                            aria-label={"Account state for " + member.name}
                            value={member.state}
                            disabled={busy || member.protected}
                            onValueChange={(state) =>
                              void propose({
                                kind: "member_state",
                                userId: member.userId,
                                state,
                              })
                            }
                            options={["active", "suspended", "archived", "removed"].map((value) => ({ value, label: value }))}
                          />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </section>
          <section
            className="space-y-3 border-t border-border pt-5"
            aria-label="Member invitations"
          >
            <h3 className="text-body font-semibold">Invite member</h3>
            {!view.emailDelivery && (
              <p role="status" className="text-label text-muted-foreground">
                Email delivery is not configured. Invitation acceptance requires an already verified
                account.
              </p>
            )}
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void propose({ kind: "invite", email, role });
              }}
            >
              <Input
                className="min-w-0 flex-1"
                aria-label="Member email"
                type="email"
                placeholder="Email address"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={busy}
              />
              <OptionSelect
                className={control}
                aria-label="Invitation role"
                value={role}
                onValueChange={setRole}
                disabled={busy}
                options={[
                  { value: "member", label: "Member" },
                  ...(view.canAssignRoles ? [{ value: "admin", label: "Manager" }] : []),
                ]}
              />
              <button
                type="submit"
                className={icon}
                aria-label="Review member invitation"
                title="Review member invitation"
                disabled={busy}
              >
                <MailPlus size={18} />
              </button>
            </form>
            {token && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label htmlFor="private-invite-token">Private invitation token</Label>
                  <button
                    className={icon}
                    title="Dismiss invitation token"
                    aria-label="Dismiss invitation token"
                    onClick={() => setToken("")}
                  >
                    <X size={16} />
                  </button>
                </div>
                <textarea
                  id="private-invite-token"
                  className={control + " w-full font-mono text-label"}
                  readOnly
                  value={token}
                />
              </div>
            )}
            <ul className="divide-y divide-border">
              {view.invitations.map((invite) => (
                <li
                  key={invite.id}
                  className="flex items-center justify-between gap-3 py-3 text-body"
                >
                  <div className="min-w-0">
                    <p className="break-all">{invite.email}</p>
                    <p className="text-label text-muted-foreground">
                      {invite.role}
                      <span className="ml-2">{invite.status === "pending" && Date.parse(invite.expiresAt) <= Date.now()
                        ? "expired"
                        : invite.status}</span>
                      <span className="ml-2">{new Date(invite.expiresAt).toLocaleString()}</span>
                    </p>
                  </div>
                  {invite.status === "pending" && (
                    <button
                      className={icon}
                      title="Review invitation revocation"
                      aria-label={"Revoke invitation for " + invite.email}
                      disabled={busy || (!view.canAssignRoles && invite.role === "admin")}
                      onClick={() => void propose({ kind: "invite_revoke", inviteId: invite.id })}
                    >
                      <X size={17} />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          {view.reviews.some((item) => item.status === "pending") && (
            <section className="space-y-3 border-t border-border pt-5">
              <h3 className="text-body font-semibold">Pending reviews</h3>
              {view.reviews
                .filter((item) => item.status === "pending")
                .map((item) => (
                  <div key={item.id} className="flex items-center justify-between gap-3 text-body">
                    <span>{description(item.action)}</span>
                    <button
                      className={icon}
                      title="Review account action"
                      aria-label="Review account action"
                      disabled={busy || Date.parse(item.expiresAt) <= Date.now()}
                      onClick={() => {
                        setReview(item);
                        setRegistrationReview(null);
                        setPhrase("");
                      }}
                    >
                      <Check size={16} />
                    </button>
                  </div>
                ))}
            </section>
          )}
        </>
      )}
      <Dialog
        open={Boolean(review || registrationReview)}
        onOpenChange={(open) => {
          if (!open && !busy) closeReview();
        }}
      >
        {(review || registrationReview) && (
          <DialogContent
            aria-describedby={undefined}
            className="max-h-[90vh] max-w-lg overflow-auto rounded-lg p-5"
          >
            <DialogTitle>{memberInvite ? "Review invitation" : "Review account changes"}</DialogTitle>
            <p className="break-words text-body">
              {registrationReview
                ? `Public registration: ${registrationReview.enabled ? "Open" : "Closed"}. Admission: ${registrationReview.allowlist.length ? registrationReview.allowlist.join(", ") : "Anyone"}. Existing accounts remain unchanged.`
                : description(review!.action)}
            </p>
            {managerInvite && (
              <p className="text-body">Managers can administer team members and bots.</p>
            )}
            {review?.action.kind === "member_state" && review.action.state !== "active" && (
              <p className="text-body text-destructive">
                This archives the member’s bots. Active or unknown work blocks the change.
                Workspaces are retained.
              </p>
            )}
            <details className="min-w-0 text-label">
              <summary>Exact change</summary>
              <pre className="mt-2 whitespace-pre-wrap break-all">
                {JSON.stringify(registrationReview ?? review?.action, null, 2)}
              </pre>
            </details>
            {!memberInvite && (
              <label className="block space-y-1 text-body">
                <span>Confirmation</span>
                <Input
                  aria-label="Account confirmation phrase"
                  placeholder={confirmation}
                  value={phrase}
                  onChange={(e) => setPhrase(e.target.value)}
                  disabled={busy}
                />
              </label>
            )}
            <label className="block space-y-1 text-body">
              <span>Your password</span>
              <Input
                aria-label="Admin account password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={busy}
              />
            </label>
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={busy} onClick={closeReview}>
                Cancel
              </Button>
              <Button
                disabled={busy || (!memberInvite && phrase !== confirmation) || !password}
                onClick={() =>
                  work(async (scope) => {
                    const result = registrationReview
                      ? await accountAdminApi("registration", {
                          ...registrationReview,
                          phrase,
                          password,
                        }, undefined, scope.spaceId)
                      : await accountAdminApi<{ enrollmentToken?: string }>("confirm", {
                          id: review!.id,
                          digest: review!.digest,
                          phrase: memberInvite ? confirmation : phrase,
                          password,
                        }, undefined, scope.spaceId);
                    if (!scope.isCurrent()) return;
                    if (
                      result &&
                      typeof result === "object" &&
                      "enrollmentToken" in result &&
                      typeof result.enrollmentToken === "string"
                    )
                      setToken(result.enrollmentToken);
                    closeReview();
                    setNotice(memberInvite ? "Invitation created." : "Account settings saved.");
                    try { await load(undefined, scope.spaceId, scope.isCurrent); }
                    catch { if (scope.isCurrent()) setError("Account change recorded. Refresh to load current settings."); }
                  })
                }
              >
                {memberInvite ? "Confirm invite" : "Apply changes"}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </section>
  );
}
