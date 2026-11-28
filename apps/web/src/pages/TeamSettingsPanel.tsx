import { Button, Dialog, DialogContent, DialogTitle, OptionSelect } from "@rakazo/ui-web";
import { Archive, Bot, Check, MailPlus, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SaveScope } from "../lib/query/query";
import { useBoundSpaceId } from "../lib/query/space-rpc";
import { useManagedOperation } from "../lib/query/use-managed-operation";
import { selectSpace } from "../lib/rpc";
import { useVisibleRefresh } from "../lib/use-visible-refresh";
import { teamApi as api, TeamUnavailable } from "./team-api";

type Member = {
  userId: string;
  name: string;
  email: string;
  role: string;
  state: string;
  quotaBytes: number;
  spaces: Array<{ id: string; name: string }>;
  storage: { available: boolean; usedBytes: number | null; enforced: boolean };
  usage: {
    calls: number;
    totalTokens: number | null;
    costUsd: number | null;
    unknownCostCalls: number;
  };
  activeRuns: number;
  computers: Array<{
    available?: boolean;
    cpuCores?: number | null;
    memoryBytes?: number | null;
    solverJobs?: unknown[];
    jobsKnown?: boolean;
  }>;
  bots: Array<{
    id: string;
    name: string;
    spaceId: string;
    archived: boolean;
    computerState: string;
  }>;
};
type Overview = {
  userId: string;
  manager: boolean;
  administrationEnabled?: boolean;
  observedAt: string;
  since: string;
  members: Member[];
};
type Action = {
  id: string;
  action: Record<string, unknown>;
  digest: string;
  status: string;
  expiresAt: string;
};
type RequestRow = {
  id: string;
  senderUserId: string;
  senderBotId: string;
  recipientUserId: string;
  recipientBotId?: string;
  message: string;
  status: string;
};
const gb = (value: number | null | undefined) =>
  typeof value === "number" ? (value / 1e9).toFixed(2) + " GB" : "Unknown";
const cell = "border-b border-border px-3 py-2 text-left align-top";
const icon =
  "inline-flex size-8 shrink-0 items-center justify-center border border-border rounded hover:bg-accent disabled:opacity-40";

export function TeamSettingsPanel() {
  const [disabled, setDisabled] = useState(false);
  const [view, setView] = useState<Overview | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [directory, setDirectory] = useState<
    Array<{ userId: string; name: string; bots?: Array<{ id: string; name: string }> }>
  >([]);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const write = useManagedOperation();
  const busy = write.pending;
  const activeSpaceId = useBoundSpaceId();
  const [selected, setSelected] = useState<Action | null>(null);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [recipient, setRecipient] = useState("");
  const [senderBot, setSenderBot] = useState("");
  const [message, setMessage] = useState("");
  const [recipientBot, setRecipientBot] = useState("");
  const requestKey = useRef<{ signature: string; key: string } | null>(null);
  const [invite, setInvite] = useState("");
  const [token, setToken] = useState("");
  const refresh = useCallback(
    async (spaceId = activeSpaceId, isCurrent: () => boolean = () => true) => {
      try {
        const value = await api<Overview>("overview", undefined, spaceId);
        const [inbox, directory, reviews] = await Promise.all([
          api<Parameters<typeof setRequests>[0]>("inbox", undefined, spaceId),
          api<Parameters<typeof setDirectory>[0]>("directory", undefined, spaceId),
          value.manager && value.administrationEnabled !== false
            ? api<Action[]>("actions", undefined, spaceId)
            : [],
        ]);
        if (!isCurrent()) return;
        setView(value);
        setRequests(inbox);
        setDirectory(directory);
        setActions(reviews);
        setError("");
        setDisabled(false);
      } catch (e) {
        if (!isCurrent()) return;
        setError(
          e instanceof TeamUnavailable
            ? e.message
            : "Team service is unavailable. Please try again later.",
        );
        setDisabled(e instanceof TeamUnavailable && e.disabled);
      }
    },
    [activeSpaceId],
  );
  useEffect(() => {
    let live = true;
    if (!disabled) void refresh(activeSpaceId, () => live);
    return () => {
      live = false;
    };
  }, [refresh, activeSpaceId, disabled]);
  useVisibleRefresh(() => void refresh(), disabled || busy ? null : 30_000);
  function perform(work: (scope: SaveScope) => Promise<unknown>) {
    write.run(async (scope) => {
      setError("");
      setNotice("");
      setPassword("");
      try {
        const result = (await work(scope)) as { enrollmentToken?: string };
        if (!scope.isCurrent()) return;
        if (result?.enrollmentToken)
          setNotice("Deliver this invitation token privately: " + result.enrollmentToken);
        await refresh(scope.spaceId, scope.isCurrent);
      } catch (e) {
        if (scope.isCurrent()) setError(String(e));
      }
    });
  }
  const propose = (action: unknown) =>
    perform(async (scope) => {
      const next = await api<Action>("propose", { action }, scope.spaceId);
      if (scope.isCurrent()) {
        setSelected(next);
        setPhrase("");
      }
    });
  const memberInvite = selected?.action.kind === "invite" && selected.action.role === "member";
  const managerInvite = selected?.action.kind === "invite" && selected.action.role === "admin";
  const own = view?.members.find((member) => member.userId === view.userId);
  const ownBots = own?.bots.filter((bot) => !bot.archived) ?? [];
  if (!view && !error)
    return (
      <section className="space-y-4 p-5 text-body">
        <h2 className="text-body-lg font-semibold">Team</h2>
        <p role="status">Loading team status…</p>
      </section>
    );
  if (disabled || (!view && error))
    return (
      <section className="space-y-4 p-5 text-body">
        <h2 className="text-body-lg font-semibold">Team</h2>
        <p role="status">{error}</p>
        <button
          type="button"
          className={icon}
          title="Retry"
          aria-label="Retry Team"
          onClick={() => {
            setDisabled(false);
            void refresh();
          }}
        >
          <RefreshCw size={16} />
        </button>
      </section>
    );
  return (
    <section className="min-w-0 space-y-5 p-4 text-body">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-body-lg font-semibold">
          {view?.manager ? "Team Administration" : "Usage And Requests"}
        </h2>
        <button
          type="button"
          className={icon}
          title="Refresh"
          aria-label="Refresh"
          disabled={busy}
          onClick={() => void refresh()}
        >
          <RefreshCw size={16} />
        </button>
      </div>
      {error && (
        <p role="alert" className="break-words text-red-700">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="break-all border-l-2 border-green-700 pl-3">
          {notice}
        </p>
      )}
      <p className="text-label text-muted-foreground">
        Last 30 days{" "}
        <span className="ml-2">
          Updated {view ? new Date(view.observedAt).toLocaleTimeString() : "—"}
        </span>
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-label">
          <thead>
            <tr>
              {[
                "Member",
                "Account",
                "Tokens / Calls",
                "Estimated USD",
                "Disk / Limit",
                "CPU / RAM",
                "Jobs",
                ...(view?.manager ? ["Actions"] : []),
              ].map((label) => (
                <th key={label} className={cell}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {view?.members.map((member) => (
              <tr key={member.userId}>
                <td className={cell}>
                  <span className="font-medium">{member.name}</span>
                  <br />
                  {member.email}
                  <br />
                  {member.role}
                </td>
                <td className={cell}>{member.state}</td>
                <td className={cell}>
                  {member.usage.totalTokens?.toLocaleString() ?? "Unknown"}
                  <br />
                  {member.usage.calls} calls
                </td>
                <td className={cell}>
                  {member.usage.costUsd === null
                    ? "Unknown"
                    : "$" + member.usage.costUsd.toFixed(4)}
                  {member.usage.unknownCostCalls > 0 && (
                    <div>{member.usage.unknownCostCalls} unpriced</div>
                  )}
                </td>
                <td className={cell}>
                  {gb(member.storage.usedBytes)} / {gb(member.quotaBytes)}
                  <br />
                  {member.storage.enforced ? "Kernel enforced" : "Not verified"}
                  {view.manager && view.administrationEnabled !== false && (
                    <form
                      className="mt-1 flex gap-1"
                      onSubmit={(event) => {
                        event.preventDefault();
                        const data = new FormData(event.currentTarget);
                        void propose({
                          kind: "quota",
                          userId: member.userId,
                          bytes: Math.round((Number(data.get("gb")) * 1e9) / 512) * 512,
                        });
                      }}
                    >
                      <input
                        key={member.quotaBytes}
                        name="gb"
                        aria-label={"Quota GB for " + member.name}
                        className="w-20 border border-border bg-background px-1 py-1"
                        type="number"
                        min="0.002"
                        max="1000"
                        step="any"
                        required
                        defaultValue={member.quotaBytes / 1e9}
                        disabled={busy}
                      />
                      <button
                        type="submit"
                        className={icon}
                        title="Review quota change"
                        aria-label={"Review quota change for " + member.name}
                        disabled={busy}
                      >
                        <Save size={14} />
                      </button>
                    </form>
                  )}
                </td>
                <td className={cell}>
                  {member.computers.length
                    ? member.computers.map((c, index) => (
                        <div key={index}>
                          {typeof c.cpuCores === "number"
                            ? c.cpuCores.toFixed(2) + " cores"
                            : "CPU unknown"}
                          <br />
                          {gb(c.memoryBytes)}
                        </div>
                      ))
                    : "No live computer"}
                </td>
                <td className={cell}>
                  {member.activeRuns} agent
                  <br />
                  {member.computers.every((c) => c.jobsKnown)
                    ? member.computers.reduce((n, c) => n + (c.solverJobs?.length ?? 0), 0) +
                      " solver"
                    : "Solver unknown"}
                </td>
                {view.manager && (
                  <td className={cell}>
                    {view.administrationEnabled === false ? (
                      "Operator disabled"
                    ) : (
                      <div className="flex gap-1">
                        <OptionSelect
                          aria-label={"Account state for " + member.name}
                          className="max-w-28"
                          value={member.state}
                          disabled={busy || member.userId === view.userId}
                          onValueChange={(state) =>
                            void propose({ kind: "member_state", userId: member.userId, state })
                          }
                          options={["active", "suspended", "archived", "removed"].map((value) => ({
                            value,
                            label: value,
                          }))}
                        />
                        <button
                          type="button"
                          className={icon}
                          title="Create bot"
                          aria-label={"Create bot for " + member.name}
                          disabled={busy || !member.spaces.length || member.state !== "active"}
                          onClick={() => {
                            const name = window.prompt("Bot name");
                            const space = member.spaces[0];
                            if (name && space)
                              void propose({
                                kind: "bot_create",
                                userId: member.userId,
                                spaceId: space.id,
                                name,
                              });
                          }}
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {view?.manager && view.administrationEnabled !== false && (
        <>
          <h3 className="text-body font-semibold">Bots</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-label">
              <thead>
                <tr>
                  {["Owner", "Bot", "Computer", "Actions"].map((x) => (
                    <th className={cell} key={x}>
                      {x}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.members.flatMap((member) =>
                  member.bots.map((bot) => (
                    <tr key={bot.id}>
                      <td className={cell}>{member.name}</td>
                      <td className={cell}>
                        <Bot size={14} className="mr-1 inline" />
                        {bot.name}
                        {bot.archived ? " (archived)" : ""}
                      </td>
                      <td className={cell}>{bot.computerState}</td>
                      <td className={cell}>
                        <div className="flex gap-1">
                          <button
                            type="button"
                            className={icon}
                            title={bot.archived ? "Restore bot" : "Archive bot"}
                            aria-label={bot.archived ? "Restore bot" : "Archive bot"}
                            disabled={busy}
                            onClick={() =>
                              void propose({
                                kind: bot.archived ? "bot_restore" : "bot_archive",
                                botId: bot.id,
                              })
                            }
                          >
                            {bot.archived ? <RefreshCw size={15} /> : <Archive size={15} />}
                          </button>
                          <button
                            type="button"
                            className={icon}
                            title="Delete bot and files"
                            aria-label="Delete bot and files"
                            disabled={busy}
                            onClick={() => void propose({ kind: "bot_delete", botId: bot.id })}
                          >
                            <Trash2 size={15} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void propose({ kind: "invite", email: invite, role: "member" });
            }}
          >
            <input
              className="min-w-0 flex-1 border border-border bg-background px-2 py-1"
              aria-label="Invite member email"
              placeholder="Member email"
              type="email"
              required
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
            <button
              type="submit"
              className={icon}
              title="Invite member"
              aria-label="Invite member"
              disabled={busy}
            >
              <MailPlus size={16} />
            </button>
          </form>
          <h3 className="text-body font-semibold">Administrative Reviews</h3>
          {actions.map((action) => (
            <div
              key={action.id}
              className="flex items-start justify-between gap-2 border-b border-border py-2"
            >
              <div className="min-w-0">
                <code className="break-all text-label">{JSON.stringify(action.action)}</code>
                <p className="text-label">
                  {action.status}{" "}
                  <span className="text-muted-foreground">
                    Expires {new Date(action.expiresAt).toLocaleTimeString()}
                  </span>
                </p>
              </div>
              {action.status === "pending" && (
                <button
                  type="button"
                  className={icon}
                  title="Review exact action"
                  aria-label="Review exact action"
                  disabled={busy}
                  onClick={() => {
                    setSelected(action);
                    setPhrase("");
                  }}
                >
                  <Check size={16} />
                </button>
              )}
            </div>
          ))}
        </>
      )}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open) {
            setSelected(null);
            setPassword("");
          }
        }}
      >
        {selected && (
          <DialogContent
            aria-describedby={undefined}
            className="max-h-[90vh] w-[calc(100%-2rem)] max-w-lg space-y-3 overflow-auto rounded p-5"
          >
            <DialogTitle className="text-body-lg font-semibold">
              {memberInvite ? "Review invitation" : "Confirm Exact Action"}
            </DialogTitle>
            {memberInvite || managerInvite ? (
              <>
                <p className="break-words text-body">
                  Invite {String(selected.action.email)} as {managerInvite ? "Manager" : "Member"}?
                </p>
                {managerInvite && (
                  <p className="text-body">Managers can administer team members and bots.</p>
                )}
              </>
            ) : (
              <>
                <pre className="whitespace-pre-wrap break-all text-label">
                  {JSON.stringify(selected.action, null, 2)}
                </pre>
                <code className="block break-all text-label">{selected.digest}</code>
                <p className="text-label">
                  Destructive operations may stop the computer and remove files. Active or unknown
                  solver work blocks them.
                </p>
              </>
            )}
            {!memberInvite && (
              <input
                className="w-full border border-border bg-background p-2"
                aria-label="Exact confirmation phrase"
                placeholder={"APPLY " + selected.id}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
              />
            )}
            <input
              className="w-full border border-border bg-background p-2"
              aria-label="Your account password"
              placeholder="Your account password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            <div className="flex justify-end gap-2">
              <button
                type="button"
                className={icon}
                title="Cancel"
                aria-label="Cancel"
                onClick={() => {
                  setSelected(null);
                  setPassword("");
                }}
              >
                <X size={16} />
              </button>
              <Button
                title={memberInvite ? "Confirm invite" : "Confirm action"}
                aria-label={memberInvite ? "Confirm invite" : "Confirm action"}
                disabled={busy || (!memberInvite && phrase !== "APPLY " + selected.id) || !password}
                onClick={() =>
                  perform(async (scope) => {
                    const result = await api(
                      "confirm",
                      {
                        id: selected.id,
                        digest: selected.digest,
                        phrase: memberInvite ? "APPLY " + selected.id : phrase,
                        password,
                      },
                      scope.spaceId,
                    );
                    if (scope.isCurrent()) setSelected(null);
                    return result;
                  })
                }
              >
                <Check size={16} />
                {memberInvite ? "Confirm invite" : null}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
      <h3 className="text-body font-semibold">Cross-User Requests</h3>
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!senderBot || !recipient || !message.trim()) return;
          perform(async (scope) => {
            const signature = JSON.stringify([senderBot, recipient, recipientBot, message]);
            if (requestKey.current?.signature !== signature)
              requestKey.current = { signature, key: crypto.randomUUID() };
            const result = await api(
              "request",
              {
                botId: senderBot,
                recipientUserId: recipient,
                ...(recipientBot ? { recipientBotId: recipientBot } : {}),
                message,
                key: requestKey.current.key,
              },
              scope.spaceId,
            );
            if (scope.isCurrent()) {
              requestKey.current = null;
              setMessage("");
            }
            return result;
          });
        }}
      >
        <div className="flex flex-wrap gap-2">
          <OptionSelect
            className="min-w-0 flex-1"
            aria-label="Sender bot"
            value={senderBot}
            onValueChange={setSenderBot}
            required
            options={[
              { value: "", label: "Your bot", disabled: true },
              ...ownBots.map((b) => ({ value: b.id, label: b.name })),
            ]}
          />
          <OptionSelect
            className="min-w-0 flex-1"
            aria-label="Recipient member"
            value={recipient}
            onValueChange={(value) => {
              setRecipient(value);
              setRecipientBot("");
            }}
            required
            options={[
              { value: "", label: "Recipient", disabled: true },
              ...directory
                .filter((d) => d.userId !== view?.userId)
                .map((d) => ({ value: d.userId, label: d.name })),
            ]}
          />
          <OptionSelect
            className="min-w-0 flex-1"
            aria-label="Recipient bot"
            value={recipientBot}
            onValueChange={setRecipientBot}
            options={[
              { value: "", label: "Recipient chooses bot" },
              ...(directory.find((d) => d.userId === recipient)?.bots ?? []).map((b) => ({
                value: b.id,
                label: b.name,
              })),
            ]}
          />
        </div>
        <textarea
          className="w-full border border-border bg-background p-2"
          aria-label="Request message"
          rows={3}
          maxLength={8000}
          required
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button
          type="submit"
          className="border border-border px-3 py-1"
          disabled={busy || !senderBot || !recipient}
        >
          Send request
        </button>
      </form>
      {requests.map((request) => (
        <div key={request.id} className="space-y-1 border-b border-border py-2">
          <p className="text-label">
            {request.senderUserId} → {request.recipientUserId}{" "}
            <span className="text-muted-foreground">{request.status}</span>
          </p>
          <p className="whitespace-pre-wrap break-words">{request.message}</p>
          {request.status === "pending" && request.recipientUserId === view?.userId && (
            <div className="flex flex-wrap gap-2">
              <OptionSelect
                className="w-auto max-w-full"
                aria-label="Receive in your bot"
                disabled={Boolean(request.recipientBotId)}
                value={request.recipientBotId ?? senderBot}
                onValueChange={setSenderBot}
                options={[
                  { value: "", label: "Your recipient bot", disabled: true },
                  ...ownBots.map((b) => ({ value: b.id, label: b.name })),
                ]}
              />
              <input
                className="min-w-0 border border-border bg-background p-1"
                aria-label="Password to accept request"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className={icon}
                title="Accept and start recipient bot"
                aria-label="Accept and start recipient bot"
                disabled={busy || !password || !(request.recipientBotId ?? senderBot)}
                onClick={() =>
                  perform((scope) =>
                    api(
                      "inbox/decide",
                      {
                        id: request.id,
                        accept: true,
                        botId: request.recipientBotId ?? senderBot,
                        password,
                      },
                      scope.spaceId,
                    ),
                  )
                }
              >
                <Check size={16} />
              </button>
              <button
                type="button"
                className={icon}
                title="Reject request"
                aria-label="Reject request"
                disabled={busy || !password}
                onClick={() =>
                  perform((scope) =>
                    api("inbox/decide", { id: request.id, accept: false, password }, scope.spaceId),
                  )
                }
              >
                <X size={16} />
              </button>
            </div>
          )}
        </div>
      ))}
      {view && (
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!token.trim()) return;
            perform(async (scope) => {
              const joined = await api<{ spaceId: string }>(
                "invite/accept",
                { token },
                scope.spaceId,
              );
              if (!scope.isCurrent()) return;
              if (!selectSpace(joined.spaceId))
                throw new Error("Joined team; select the new workspace after refreshing.");
              window.location.reload();
            });
          }}
        >
          <input
            className="min-w-0 flex-1 border border-border bg-background p-1"
            aria-label="Private invitation token"
            placeholder="Invitation token"
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
          <button
            type="submit"
            className="border border-border px-3 py-1"
            disabled={busy || !token}
          >
            Join team
          </button>
        </form>
      )}
    </section>
  );
}
