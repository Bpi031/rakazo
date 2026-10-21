import { useEffect, useState } from "react";
import { Check, Pause, RefreshCw, ShieldCheck, Workflow, X } from "lucide-react";
import { withSpaceHeaders } from "../lib/rpc";
import type { WorkflowDefinition } from "@rakazo/contracts";

export type WorkflowView = {
  id: string;
  digest: string;
  name: string;
  status: string;
  ready: boolean;
  manager: boolean;
  leadBotId: string;
  definition: WorkflowDefinition;
  expiresAt: string;
  reviewExpiresAt: string;
  participants: Array<{ botId: string; name: string; consented: boolean; you: boolean }>;
  executions: Array<{
    id: string;
    status: string;
    createdAt: string;
    steps: Array<{ botId: string; lead: boolean; status: string; text?: string }>;
  }>;
};
type Handover = {
  id: string;
  digest: string;
  status: string;
  sender: boolean;
  fromBotId: string;
  toBotId: string;
  fromName: string;
  toName: string;
  sourceRemainsOwner: boolean;
  workflows: Array<{ id: string; name: string }>;
  expiresAt: string;
};
export async function workflowApi<T>(
  operation: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(
    operation.startsWith("leadership/")
      ? "/api/team-leadership/" + operation.slice(11)
      : "/api/team-workflows/" + operation,
    {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(12_000)]),
      headers: withSpaceHeaders(body === undefined ? {} : { "content-type": "application/json" }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error("Workflow request was not confirmed. Refresh and review again.");
  return response.json() as Promise<T>;
}
const icon =
  "inline-flex size-8 shrink-0 items-center justify-center rounded-md hover:bg-accent disabled:opacity-40";
export function TeamWorkflowsPanel({
  botId,
  selectedId,
  onClose,
}: {
  botId: string;
  selectedId?: string;
  onClose: () => void;
}) {
  const [items, setItems] = useState<WorkflowView[]>([]);
  const [error, setError] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [review, setReview] = useState<{
    item: WorkflowView;
    operation: "enable" | "pause" | "consent" | "revoke";
  } | null>(null);
  const [password, setPassword] = useState("");
  const [checked, setChecked] = useState(false);
  const [handovers, setHandovers] = useState<Handover[]>([]);
  const [handoverReview, setHandoverReview] = useState<{
    item: Handover;
    operation: "offer" | "accept" | "decline" | "cancel";
  } | null>(null);
  async function load(signal?: AbortSignal) {
    const [value, transfers] = await Promise.all([
      workflowApi<WorkflowView[]>("list", undefined, signal),
      workflowApi<Handover[]>("leadership/list", undefined, signal),
    ]);
    if (signal?.aborted) return;
    setItems(
      value.filter((f) =>
        selectedId && selectedId !== "all"
          ? f.id === selectedId
          : f.participants.some((p) => p.botId === botId),
      ),
    );
    setHandovers(transfers.filter((h) => h.fromBotId === botId || h.toBotId === botId));
    setLoaded(true);
  }
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError("");
    void load(controller.signal).catch((e) => {
      if (!controller.signal.aborted) setError(e.message);
    });
    return () => controller.abort();
  }, [botId, selectedId]);
  useEffect(() => {
    const controller = new AbortController();
    let loading = false;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible" || loading || busy || review || handoverReview)
        return;
      loading = true;
      void load(controller.signal)
        .catch(() => {})
        .finally(() => {
          loading = false;
        });
    }, 10_000);
    return () => {
      clearInterval(timer);
      controller.abort();
    };
  }, [botId, selectedId, busy, review, handoverReview]);
  function choose(item: WorkflowView, operation: "enable" | "pause" | "consent" | "revoke") {
    setHandoverReview(null);
    setReview({ item, operation });
    setPassword("");
    setChecked(false);
  }
  function chooseHandover(item: Handover, operation: "offer" | "accept" | "decline" | "cancel") {
    setReview(null);
    setHandoverReview({ item, operation });
    setPassword("");
    setChecked(false);
  }
  async function confirm() {
    const current = review ?? handoverReview;
    if (!current || !password || !checked || busy) return;
    setBusy(true);
    setError("");
    try {
      await workflowApi(handoverReview ? "leadership/decide" : "decide", {
        id: current.item.id,
        digest: current.item.digest,
        operation: current.operation,
        password,
      });
      setReview(null);
      setHandoverReview(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setPassword("");
    }
  }
  return (
    <section
      aria-label="Team workflows"
      className="min-w-0 border-b border-border bg-background p-4"
    >
      <header className="flex items-center gap-2">
        <Workflow size={18} />
        <h2 className="min-w-0 flex-1 text-sm font-semibold">Team workflows</h2>
        <button
          className={icon}
          title="Refresh workflows"
          aria-label="Refresh workflows"
          disabled={busy}
          onClick={() => {
            setError("");
            void load().catch((e) => setError(e.message));
          }}
        >
          <RefreshCw size={16} />
        </button>
        <button
          className={icon}
          title="Close workflows"
          aria-label="Close workflows"
          onClick={onClose}
        >
          <X size={16} />
        </button>
      </header>
      {error && (
        <p role="alert" className="my-2 break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {!loaded && !error && (
        <p role="status" className="py-3 text-sm">
          Loading workflows...
        </p>
      )}
      {loaded && !items.length && !handovers.length && (
        <p className="py-3 text-sm text-muted-foreground">No workflow for this bot.</p>
      )}
      <div className="max-h-[55vh] space-y-5 overflow-auto">
        {handovers.map((h) => (
          <article key={h.id} className="min-w-0 space-y-3 border-t border-border pt-3">
            <h3 className="break-words text-sm font-semibold">
              Leadership handover: {h.fromName} to {h.toName}
            </h3>
            <p className="text-sm">
              {h.status} ·{" "}
              {h.sourceRemainsOwner
                ? "Original owner remains owner; successor becomes a team manager."
                : "Current manager becomes a member; successor becomes a manager."}
            </p>
            <p className="text-sm">
              Private bot histories, files and licenses stay separate. Existing solves are not
              transferred. {h.workflows.length} workflow definition(s) will become new drafts
              requiring fresh consent.
            </p>
            <ul className="text-sm">
              {h.workflows.map((w) => (
                <li key={w.id} className="break-words">
                  {w.name}
                </li>
              ))}
            </ul>
            <p className="break-all text-xs text-muted-foreground">Digest: {h.digest}</p>
            {Date.parse(h.expiresAt) > Date.now() && ["draft", "offered"].includes(h.status) && (
              <div className="flex flex-wrap gap-2">
                {h.sender && h.status === "draft" && (
                  <button
                    className="rounded border border-border px-3 py-1.5 text-sm"
                    onClick={() => chooseHandover(h, "offer")}
                  >
                    Review handover offer
                  </button>
                )}
                {!h.sender && h.status === "offered" && (
                  <button
                    className="rounded border border-border px-3 py-1.5 text-sm"
                    onClick={() => chooseHandover(h, "accept")}
                  >
                    Review acceptance
                  </button>
                )}
                <button
                  className="rounded border border-border px-3 py-1.5 text-sm"
                  onClick={() => chooseHandover(h, h.sender ? "cancel" : "decline")}
                >
                  {h.sender ? "Cancel handover" : "Decline handover"}
                </button>
              </div>
            )}
          </article>
        ))}
        {items.map((item) => (
          <article key={item.id} className="min-w-0 space-y-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <h3 className="break-words text-sm font-semibold">{item.name}</h3>
              <span className="text-xs text-muted-foreground">
                {item.status} · {item.ready ? "Ready" : "Awaiting consent / review"}
              </span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{item.definition.objective}</p>
            <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
              <div>
                <dt>Model</dt>
                <dd className="break-all">{item.definition.modelId}</dd>
              </div>
              <div>
                <dt>Daily starts</dt>
                <dd>{item.definition.maxStartsPerDay}</dd>
              </div>
              <div>
                <dt>Output tokens / step</dt>
                <dd>{item.definition.maxOutputTokens}</dd>
              </div>
              <div>
                <dt>Grant expires</dt>
                <dd>{new Date(item.expiresAt).toLocaleDateString()}</dd>
              </div>
            </dl>
            <ul className="space-y-2 text-sm">
              {item.participants.map((p, i) => (
                <li key={p.botId} className="flex flex-wrap items-center gap-2">
                  <span className="break-words">
                    {p.name}
                    {i === 0 ? " · Lead" : ""}
                    {p.you ? " · You" : ""}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {p.consented ? "Consented" : "Consent needed"}
                  </span>
                  {p.you && (
                    <button
                      className="rounded border border-border px-2 py-1 text-xs"
                      disabled={busy}
                      onClick={() => choose(item, p.consented ? "revoke" : "consent")}
                    >
                      {p.consented ? "Revoke consent" : "Review consent"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
            <details className="text-sm">
              <summary>Exact flow and shared-data boundary</summary>
              <div className="mt-2 space-y-2">
                <p>
                  Only explicitly submitted text is shared with every participant. Responses go to
                  the lead. No private files, chats, memory, shell, Rost or external actions are
                  available to automated steps.
                </p>
                <p>
                  {item.definition.allowParticipantStart
                    ? "Consenting participants may submit a message to start a flow."
                    : "Only the manager's lead bot may start a flow."}
                </p>
                {item.definition.participants.map((p) => (
                  <p key={p.botId} className="whitespace-pre-wrap break-words">
                    {item.participants.find((b) => b.botId === p.botId)?.name}: {p.instruction}
                  </p>
                ))}
                <p className="break-all text-xs text-muted-foreground">Digest: {item.digest}</p>
              </div>
            </details>
            {item.manager && (
              <div className="flex flex-wrap gap-2">
                <button
                  className="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm"
                  disabled={busy || Date.parse(item.expiresAt) <= Date.now()}
                  onClick={() => choose(item, "enable")}
                >
                  <Check size={14} />
                  {item.status === "active" ? "Review grant" : "Review and enable"}
                </button>
                <button
                  className="inline-flex items-center gap-2 rounded border border-border px-3 py-1.5 text-sm"
                  disabled={busy || item.status !== "active"}
                  onClick={() => choose(item, "pause")}
                >
                  <Pause size={14} />
                  Pause
                </button>
              </div>
            )}
            {item.executions.map((e) => (
              <details key={e.id} className="text-sm">
                <summary className="break-words">
                  {new Date(e.createdAt).toLocaleString()} · {e.status}
                </summary>
                <ul className="mt-2 space-y-3">
                  {e.steps.map((s) => (
                    <li key={s.botId} className="whitespace-pre-wrap break-words">
                      <strong>
                        {item.participants.find((p) => p.botId === s.botId)?.name} · {s.status}
                      </strong>
                      <p>{s.text}</p>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </article>
        ))}
      </div>
      {handoverReview && (
        <div
          role="dialog"
          aria-label="Review leadership handover"
          className="mt-4 space-y-3 border-t border-border pt-4"
        >
          <h3 className="text-sm font-semibold">
            Confirm {handoverReview.operation}: {handoverReview.item.fromName} to{" "}
            {handoverReview.item.toName}
          </h3>
          <p className="text-sm">
            This changes team leadership only. No private history, files, credentials, licenses or
            active solves move. Both people must confirm the exact handover. Ownership is not
            transferred.
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Confirm exact leadership handover"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={busy}
            />
            I reviewed the role changes and successor bot.
          </label>
          <label className="block text-sm">
            Current password
            <input
              type="password"
              aria-label="Leadership account password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded border border-border bg-background p-2"
            />
          </label>
          <div className="flex gap-2">
            <button
              disabled={busy || !checked || !password}
              className="rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
              onClick={() => void confirm()}
            >
              Confirm leadership decision
            </button>
            <button
              disabled={busy}
              className="px-3 py-2 text-sm"
              onClick={() => {
                setHandoverReview(null);
                setPassword("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {review && (
        <div
          role="dialog"
          aria-label="Review workflow permission"
          className="mt-4 space-y-3 border-t border-border pt-4"
        >
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck size={16} />
            Review: {review.operation} · {review.item.name}
          </h3>
          <p className="text-sm">
            {review.operation === "enable" || review.operation === "consent"
              ? "Authorize this exact message-only flow and its stated sharing, model and limits. This does not approve policy changes, private-file access or a solve."
              : "Stop future workflow delivery. Information already received cannot be made unread."}
          </p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Confirm exact workflow grant"
              checked={checked}
              onChange={(e) => setChecked(e.target.checked)}
              disabled={busy}
            />
            I reviewed the exact flow and recipients.
          </label>
          <label className="block text-sm">
            Current password
            <input
              type="password"
              aria-label="Workflow account password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
              className="mt-1 w-full rounded border border-border bg-background p-2"
            />
          </label>
          <div className="flex gap-2">
            <button
              disabled={busy || !checked || !password}
              className="rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
              onClick={() => void confirm()}
            >
              Confirm workflow decision
            </button>
            <button
              disabled={busy}
              className="px-3 py-2 text-sm"
              onClick={() => {
                setReview(null);
                setPassword("");
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
