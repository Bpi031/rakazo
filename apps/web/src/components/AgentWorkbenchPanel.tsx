import { useEffect, useRef, useState } from "react";
import { BookOpen, Check, GitBranch, RefreshCw, Send, X } from "lucide-react";
import { withSpaceHeaders } from "../lib/rpc";
import { NativeAgentPanel } from "./NativeAgentPanel";

export async function workbenchApi(
  operation: string,
  botId: string,
  body?: unknown,
  signal?: AbortSignal,
) {
  const [route, extra] = operation.split("&");
  const response = await fetch(
    "/api/agent-workbench/" +
      route +
      (body === undefined
        ? "?botId=" + encodeURIComponent(botId) + (extra ? "&" + extra : "")
        : ""),
    {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      headers: withSpaceHeaders(body === undefined ? {} : { "content-type": "application/json" }),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(body === undefined ? 15000 : 110000),
      ]),
      ...(body === undefined ? {} : { body: JSON.stringify({ botId, ...(body as any) }) }),
    },
  );
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      "The operation was not confirmed. Refresh and review permissions, source and limits.",
    );
  return response.json();
}
const tabs = ["goals", "scenarios", "changes", "skills", "helpers", "checks", "runtime"] as const;
type Tab = (typeof tabs)[number];
const button =
  "inline-flex items-center justify-center gap-2 rounded border border-border px-3 py-2 text-sm disabled:opacity-40";
const input = "w-full min-w-0 rounded border border-border bg-background p-2 text-sm";
function nonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = Array.from(bytes, (v) => v.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
export function AgentWorkbenchPanel({
  botId,
  initialTab,
  initialReview,
  onClose,
}: {
  botId: string;
  initialTab?: string;
  initialReview?: string;
  onClose: () => void;
}) {
  const [tab, setTab] = useState<Tab>(
    tabs.includes(initialTab as Tab) ? (initialTab as Tab) : "goals",
  );
  const [view, setView] = useState<any>();
  const [detail, setDetail] = useState<any>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [objective, setObjective] = useState("");
  const [goalStatus, setGoalStatus] = useState("active");
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState("");
  const [message, setMessage] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [password, setPassword] = useState("");
  const [receipt, setReceipt] = useState<any>();
  const controller = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const submitting = useRef(false);
  const detailId = useRef<string | undefined>(undefined);
  const refresh = async (signal?: AbortSignal) => {
    const value = await workbenchApi("view", botId, undefined, signal);
    if (!alive.current) return;
    setView(value);
    if (!editing) {
      setObjective(value.goal.objective);
      setGoalStatus(value.goal.status);
    }
  };
  const open = async (id: string, signal?: AbortSignal) => {
    setConfirm(false);
    setPassword("");
    setReceipt(undefined);
    const value = await workbenchApi(
      "detail&id=" + encodeURIComponent(id),
      botId,
      undefined,
      signal,
    );
    if (alive.current) {
      detailId.current = value.id;
      setDetail(value);
      if (value.kind === "goal_proposal") {
        setObjective(value.payload.objective);
        setGoalStatus("active");
        setEditing(true);
      }
    }
  };
  useEffect(() => {
    alive.current = true;
    const c = new AbortController();
    controller.current = c;
    refresh(c.signal)
      .then(() => (initialReview ? open(initialReview, c.signal) : undefined))
      .catch(() => {
        if (!c.signal.aborted)
          setError(
            "Workbench is unavailable. Check the current session and deployment capability.",
          );
      });
    return () => {
      alive.current = false;
      c.abort();
    };
  }, [botId]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible" && !busy && !editing && !password && !confirm)
        void refresh(controller.current?.signal)
          .then(async () => {
            const id = detailId.current;
            if (!id) return;
            const value = await workbenchApi(
              "detail&id=" + encodeURIComponent(id),
              botId,
              undefined,
              controller.current?.signal,
            );
            if (alive.current && detailId.current === id) setDetail(value);
          })
          .catch(() => {});
    }, 10000);
    return () => clearInterval(timer);
  }, [botId, busy, editing, password, confirm]);
  const decide = async (body: any) => {
    if (submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await workbenchApi("decide", botId, body);
      if (!alive.current) return;
      setPassword("");
      setConfirm(false);
      await refresh();
      return result;
    } catch {
      if (alive.current)
        setError(
          "The operation was not confirmed. Review the current source, permissions and finite limits before retrying.",
        );
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const records =
    view?.records?.filter((r: any) =>
      tab === "scenarios"
        ? r.kind === "scenario"
        : tab === "changes"
          ? ["change", "draft_receipt"].includes(r.kind)
          : tab === "helpers"
            ? r.kind === "helper"
            : tab === "checks"
              ? r.kind === "hook"
              : tab === "goals"
                ? r.kind === "goal_proposal"
                : false,
    ) ?? [];
  return (
    <section
      aria-label="Agent workbench"
      className="min-w-0 border-b border-border bg-background p-3 sm:p-4"
    >
      <header className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold">Agent workbench</h2>
        <div className="flex gap-1">
          <button
            className="p-2"
            title="Refresh workbench"
            aria-label="Refresh workbench"
            disabled={busy}
            onClick={() => {
              void refresh().catch(() => setError("Refresh failed"));
            }}
          >
            <RefreshCw size={16} />
          </button>
          <button
            className="p-2"
            title="Close workbench"
            aria-label="Close workbench"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </div>
      </header>
      <div
        role="tablist"
        aria-label="Workbench views"
        className="my-3 flex min-w-0 gap-1 overflow-x-auto border-b border-border"
      >
        {tabs.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={
              "shrink-0 border-b-2 px-3 py-2 text-sm capitalize " +
              (tab === t ? "border-foreground" : "border-transparent text-muted-foreground")
            }
            onClick={() => {
              setTab(t);
              setDetail(undefined);
              detailId.current = undefined;
              setError("");
              setPassword("");
              setConfirm(false);
            }}
          >
            {t}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="mb-3 break-words text-sm text-destructive">
          {error}
        </p>
      )}
      {!view ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : (
        <div className="max-h-[60vh] min-w-0 space-y-4 overflow-auto">
          {tab==='runtime'&&<NativeAgentPanel botId={botId}/>}
          {tab === "goals" && (
            <form
              className="space-y-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const result = await decide({
                  operation: "goal",
                  revision: view.goal.revision,
                  goal: { objective, status: goalStatus },
                });
                if (result) setEditing(false);
              }}
            >
              <textarea
                aria-label="Task goal"
                rows={3}
                maxLength={4000}
                className={input}
                value={objective}
                onChange={(e) => {
                  setObjective(e.target.value);
                  setEditing(true);
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Goal status"
                  className="rounded border border-border bg-background p-2 text-sm"
                  value={goalStatus}
                  onChange={(e) => {
                    setGoalStatus(e.target.value);
                    setEditing(true);
                  }}
                >
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                  <option value="complete">User marked complete</option>
                </select>
                <button className={button} disabled={busy || !objective.trim()}>
                  <Check size={16} />
                  Save goal
                </button>
                <span className="text-xs text-muted-foreground">Revision {view.goal.revision}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                Task tracking only. Policy approval, solver allowance and candidate validation
                remain separate.
              </p>
            </form>
          )}
          {tab === "scenarios" && (
            <>
              <form
                className="flex min-w-0 flex-wrap gap-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const result = await decide({ operation: "scenario", title, nonce: nonce() });
                  if (result) {
                    setTitle("");
                    await open(result.id);
                  }
                }}
              >
                <input
                  aria-label="Scenario title"
                  className={input + " flex-1 basis-48"}
                  value={title}
                  maxLength={200}
                  onChange={(e) => setTitle(e.target.value)}
                />
                <button className={button} disabled={busy || !title.trim()}>
                  <GitBranch size={16} />
                  New analysis branch
                </button>
              </form>
              <p className="text-xs text-muted-foreground">
                Private discussion snapshot only. No tools, files, approvals or active solves
                transfer.
              </p>
            </>
          )}
          {tab === "skills" && (
            <>
              <button
                className={button}
                disabled={busy}
                onClick={() => void decide({ operation: "refresh_skills" })}
              >
                <RefreshCw size={16} />
                Refresh installed skills
              </button>
              <ul className="divide-y divide-border">
                {view.skills.map((skill: any) => (
                  <li
                    key={skill.id}
                    className="flex min-w-0 items-start justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="break-words text-sm font-medium">{skill.name}</p>
                      <p className="break-words text-xs text-muted-foreground">
                        {skill.description}
                      </p>
                      <code className="break-all text-[10px] text-muted-foreground">
                        {skill.sha256}
                      </code>
                    </div>
                    <button
                      className={button + " shrink-0"}
                      disabled={busy}
                      onClick={() =>
                        void decide({
                          operation: "select_skill",
                          id: view.selectedSkill?.id === skill.id ? null : skill.id,
                        })
                      }
                    >
                      <BookOpen size={16} />
                      {view.selectedSkill?.id === skill.id ? "Selected" : "Next turn"}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
          {tab === "checks" && (
            <ul className="divide-y divide-border">
              {view.hooks.map((h: any) => (
                <li key={h.name} className="py-2">
                  <p className="text-sm font-medium">
                    {h.name} · v{h.version}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">{h.description}</p>
                </li>
              ))}
            </ul>
          )}
          {records.length > 0 && (
            <ul className="divide-y divide-border">
              {records.map((r: any) => (
                <li key={r.id}>
                  <button
                    className="flex w-full min-w-0 items-start justify-between gap-3 py-2 text-left text-sm hover:bg-muted"
                    disabled={busy}
                    onClick={() =>
                      void open(r.id).catch(() => setError("Record changed or unavailable"))
                    }
                  >
                    <span className="min-w-0 break-words">{r.title}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">{r.status}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {detail &&
            ((tab === "changes" && ["change", "draft_receipt"].includes(detail.kind)) ||
              (tab === "scenarios" && detail.kind === "scenario") ||
              (tab === "helpers" && detail.kind === "helper") ||
              (tab === "checks" && detail.kind === "hook")) && (
              <article className="min-w-0 space-y-3 border-t border-border pt-3">
                <p className="break-all text-xs text-muted-foreground">Digest: {detail.digest}</p>
                {detail.kind === "change" ? (
                  <>
                    <h3 className="break-words text-sm font-semibold">{detail.payload.path}</h3>
                    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
                      {[
                        ["Current source", detail.payload.before],
                        ["Proposed separate draft", detail.payload.proposedText],
                      ].map(([label, text]) => (
                        <div key={label} className="min-w-0">
                          <h4 className="mb-1 text-xs font-semibold">{label}</h4>
                          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words border border-border p-2 text-xs">
                            {text}
                          </pre>
                        </div>
                      ))}
                    </div>
                    <p className="break-all text-xs text-muted-foreground">
                      Source SHA-256: {detail.payload.sourceSha256}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Saving never overwrites this source or approves a policy. Rost review, solve
                      and validation still apply.
                    </p>
                    {detail.status === "draft" && (
                      <form
                        className="space-y-2"
                        onSubmit={async (e) => {
                          e.preventDefault();
                          if (!confirm || !password) return;
                          const result = await decide({
                            operation: "save_draft",
                            id: detail.id,
                            digest: detail.digest,
                            password,
                          });
                          if (result) {
                            setReceipt(result);
                            await open(detail.id);
                            setReceipt(result);
                          }
                        }}
                      >
                        <label className="flex items-start gap-2 text-sm">
                          <input
                            aria-label="Confirm exact separate draft"
                            type="checkbox"
                            checked={confirm}
                            onChange={(e) => setConfirm(e.target.checked)}
                          />
                          <span>Save these exact bytes as a separate draft</span>
                        </label>
                        <input
                          className={input}
                          aria-label="Draft account password"
                          type="password"
                          autoComplete="current-password"
                          value={password}
                          onChange={(e) => setPassword(e.target.value)}
                        />
                        <button className={button} disabled={!confirm || !password || busy}>
                          <Check size={16} />
                          Save reviewed draft
                        </button>
                      </form>
                    )}
                    {receipt && (
                      <p className="break-all text-sm" role="status">
                        Saved draft: {receipt.draftPath}
                      </p>
                    )}
                  </>
                ) : detail.kind === "scenario" ? (
                  <>
                    <p className="text-sm font-semibold">{detail.payload.title}</p>
                    <p className="break-all text-xs text-muted-foreground">
                      Source snapshot: {detail.payload.sourceDigest}
                    </p>
                    {detail.payload.messages.map((m: any) => (
                      <div key={m.nonce} className="space-y-2 border-t border-border pt-2">
                        <p className="whitespace-pre-wrap break-words text-sm font-medium">
                          {m.question}
                        </p>
                        <p className="whitespace-pre-wrap break-words text-sm">{m.answer}</p>
                        {m.needsApproval && (
                          <p className="text-xs text-muted-foreground">
                            Human decision required. No action executed.
                          </p>
                        )}
                      </div>
                    ))}
                    <form
                      className="space-y-2"
                      onSubmit={async (e) => {
                        e.preventDefault();
                        const result = await decide({
                          operation: "scenario_message",
                          id: detail.id,
                          message,
                          nonce: nonce(),
                        });
                        if (result) {
                          setMessage("");
                          await open(detail.id);
                        }
                      }}
                    >
                      <textarea
                        aria-label="Scenario question"
                        className={input}
                        rows={3}
                        maxLength={8000}
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                      />
                      <button className={button} disabled={busy || !message.trim()}>
                        <Send size={16} />
                        Analyze scenario
                      </button>
                    </form>
                  </>
                ) : (
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words text-xs">
                    {JSON.stringify(detail.payload.result ?? detail.payload, null, 2)}
                  </pre>
                )}
              </article>
            )}
        </div>
      )}
    </section>
  );
}
