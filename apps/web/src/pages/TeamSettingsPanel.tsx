import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, Bot, Check, MailPlus, Plus, RefreshCw, Save, Trash2, X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@rakazo/ui-web";
import { selectSpace } from "../lib/rpc";
import { teamApi as api, TeamUnavailable } from "./team-api";

type Member = { userId: string; name: string; email: string; role: string; state: string; quotaBytes: number;
  spaces: Array<{ id: string; name: string }>;
  storage: { available: boolean; usedBytes: number | null; enforced: boolean };
  usage: { calls: number; totalTokens: number | null; costUsd: number | null; unknownCostCalls: number };
  activeRuns: number; computers: Array<{ available?: boolean; cpuCores?: number | null; memoryBytes?: number | null; solverJobs?: unknown[]; jobsKnown?: boolean }>;
  bots: Array<{ id: string; name: string; spaceId: string; archived: boolean; computerState: string }> };
type Overview = { userId: string; manager: boolean; administrationEnabled?: boolean; observedAt: string; since: string; members: Member[] };
type Action = { id: string; action: Record<string, unknown>; digest: string; status: string; expiresAt: string };
type RequestRow = { id: string; senderUserId: string; senderBotId: string; recipientUserId: string; recipientBotId?: string; message: string; status: string };
const gb = (value: number | null | undefined) => typeof value === "number" ? (value / 1e9).toFixed(2) + " GB" : "Unknown";
const cell = "border-b border-border px-3 py-2 text-left align-top";
const icon = "inline-flex size-8 shrink-0 items-center justify-center border border-border rounded hover:bg-accent disabled:opacity-40";

export function TeamSettingsPanel() {
  const [disabled, setDisabled] = useState(false);
  const [view, setView] = useState<Overview | null>(null);
  const [actions, setActions] = useState<Action[]>([]);
  const [requests, setRequests] = useState<RequestRow[]>([]);
  const [directory, setDirectory] = useState<Array<{ userId: string; name: string; bots?: Array<{ id: string; name: string }> }>>([]);
  const [error, setError] = useState(""); const [notice, setNotice] = useState(""); const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Action | null>(null); const [password, setPassword] = useState(""); const [phrase, setPhrase] = useState("");
  const [recipient, setRecipient] = useState(""); const [senderBot, setSenderBot] = useState(""); const [message, setMessage] = useState("");
  const [recipientBot, setRecipientBot] = useState("");
  const requestKey = useRef<{ signature: string; key: string } | null>(null);
  const [invite, setInvite] = useState(""); const [token, setToken] = useState("");
  const refresh = useCallback(async () => {
    try { const value = await api<Overview>("overview"); setView(value); setRequests(await api("inbox")); setDirectory(await api("directory"));
      setActions(value.manager && value.administrationEnabled !== false ? await api("actions") : []); setError(""); setDisabled(false); }
    catch (e) { setError(e instanceof TeamUnavailable ? e.message : "Team service is unavailable. Please try again later.");
      setDisabled(e instanceof TeamUnavailable && e.disabled); }
  }, []);
  useEffect(() => { if (disabled) return; void refresh(); const timer = setInterval(() => void refresh(), 30_000); return () => clearInterval(timer); }, [refresh, disabled]);
  async function perform(work: () => Promise<unknown>) {
    if (busy) return; setBusy(true); setError(""); setNotice("");
    try { const result = await work() as { enrollmentToken?: string }; if (result?.enrollmentToken) setNotice("Deliver this invitation token privately: " + result.enrollmentToken);
      await refresh(); } catch (e) { setError(String(e)); } finally { setPassword(""); setBusy(false); }
  }
  const propose = (action: unknown) => perform(async () => { const next = await api<Action>("propose", { action }); setSelected(next); setPhrase(""); });
  const own = view?.members.find((member) => member.userId === view.userId);
  const ownBots = own?.bots.filter((bot) => !bot.archived) ?? [];
  if (!view && !error) return <section className="space-y-4 p-5 text-sm">
    <h2 className="text-base font-semibold">Team</h2><p role="status">Loading team status…</p>
  </section>;
  if (disabled || (!view && error)) return <section className="space-y-4 p-5 text-sm">
    <h2 className="text-base font-semibold">Team</h2><p role="status">{error}</p>
    <button className={icon} title="Retry" aria-label="Retry Team" onClick={() => { setDisabled(false); void refresh(); }}><RefreshCw size={16}/></button>
  </section>;
  return <section className="min-w-0 space-y-5 p-4 text-sm">
    <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">{view?.manager ? "Team Administration" : "Usage And Requests"}</h2>
      <button className={icon} title="Refresh" aria-label="Refresh" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16}/></button></div>
    {error && <p role="alert" className="break-words text-red-700">{error}</p>}
    {notice && <p role="status" className="break-all border-l-2 border-green-700 pl-3">{notice}</p>}
    <p className="text-xs text-muted-foreground">Last 30 days · Updated {view ? new Date(view.observedAt).toLocaleTimeString() : "—"}</p>
    <div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr>{["Member", "Account", "Tokens / Calls", "Estimated USD", "Disk / Limit", "CPU / RAM", "Jobs", ...(view?.manager ? ["Actions"] : [])].map((label) => <th key={label} className={cell}>{label}</th>)}</tr></thead>
      <tbody>{view?.members.map((member) => <tr key={member.userId}>
        <td className={cell}><span className="font-medium">{member.name}</span><br/>{member.email}<br/>{member.role}</td><td className={cell}>{member.state}</td>
        <td className={cell}>{member.usage.totalTokens?.toLocaleString() ?? "Unknown"}<br/>{member.usage.calls} calls</td>
        <td className={cell}>{member.usage.costUsd === null ? "Unknown" : "$" + member.usage.costUsd.toFixed(4)}{member.usage.unknownCostCalls > 0 && <div>{member.usage.unknownCostCalls} unpriced</div>}</td>
        <td className={cell}>{gb(member.storage.usedBytes)} / {gb(member.quotaBytes)}<br/>{member.storage.enforced ? "Kernel enforced" : "Not verified"}
          {view.manager && view.administrationEnabled !== false && <form className="mt-1 flex gap-1" onSubmit={(event) => { event.preventDefault(); const data = new FormData(event.currentTarget);
            void propose({ kind: "quota", userId: member.userId, bytes: Math.round(Number(data.get("gb")) * 1e9 / 512) * 512 }); }}>
            <input key={member.quotaBytes} name="gb" aria-label={"Quota GB for " + member.name} className="w-20 border border-border bg-background px-1 py-1" type="number" min="0.002" max="1000" step="any" required defaultValue={member.quotaBytes / 1e9} disabled={busy}/>
            <button className={icon} title="Review quota change" aria-label={"Review quota change for " + member.name} disabled={busy}><Save size={14}/></button>
          </form>}</td>
        <td className={cell}>{member.computers.length ? member.computers.map((c, index) => <div key={index}>{typeof c.cpuCores === "number" ? c.cpuCores.toFixed(2) + " cores" : "CPU unknown"}<br/>{gb(c.memoryBytes)}</div>) : "No live computer"}</td>
        <td className={cell}>{member.activeRuns} agent<br/>{member.computers.every((c) => c.jobsKnown) ? member.computers.reduce((n, c) => n + (c.solverJobs?.length ?? 0), 0) + " solver" : "Solver unknown"}</td>
        {view.manager && <td className={cell}>{view.administrationEnabled === false ? "Operator disabled" : <div className="flex gap-1">
          <select aria-label={"Account state for " + member.name} className="max-w-28 border border-border bg-background" value={member.state} disabled={busy || member.userId === view.userId}
            onChange={(event) => void propose({ kind: "member_state", userId: member.userId, state: event.target.value })}>{["active", "suspended", "archived", "removed"].map((s) => <option key={s}>{s}</option>)}</select>
          <button className={icon} title="Create bot" aria-label={"Create bot for " + member.name} disabled={busy || !member.spaces.length || member.state !== "active"} onClick={() => {
            const name = window.prompt("Bot name"); const space = member.spaces[0]; if (name && space) void propose({ kind: "bot_create", userId: member.userId, spaceId: space.id, name }); }}><Plus size={16}/></button>
        </div>}</td>}
      </tr>)}</tbody></table></div>
    {view?.manager && view.administrationEnabled !== false && <><h3 className="text-sm font-semibold">Bots</h3><div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr>{["Owner", "Bot", "Computer", "Actions"].map((x) => <th className={cell} key={x}>{x}</th>)}</tr></thead><tbody>
      {view.members.flatMap((member) => member.bots.map((bot) => <tr key={bot.id}><td className={cell}>{member.name}</td><td className={cell}><Bot size={14} className="mr-1 inline"/>{bot.name}{bot.archived ? " (archived)" : ""}</td><td className={cell}>{bot.computerState}</td><td className={cell}><div className="flex gap-1">
        <button className={icon} title={bot.archived ? "Restore bot" : "Archive bot"} aria-label={bot.archived ? "Restore bot" : "Archive bot"} disabled={busy} onClick={() => void propose({ kind: bot.archived ? "bot_restore" : "bot_archive", botId: bot.id })}>{bot.archived ? <RefreshCw size={15}/> : <Archive size={15}/>}</button>
        <button className={icon} title="Delete bot and files" aria-label="Delete bot and files" disabled={busy} onClick={() => void propose({ kind: "bot_delete", botId: bot.id })}><Trash2 size={15}/></button></div></td></tr>))}
    </tbody></table></div>
    <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void propose({ kind: "invite", email: invite, role: "member" }); }}>
      <input className="min-w-0 flex-1 border border-border bg-background px-2 py-1" aria-label="Invite member email" placeholder="Member email" type="email" required value={invite} onChange={(e) => setInvite(e.target.value)}/>
      <button className={icon} title="Invite member" aria-label="Invite member" disabled={busy}><MailPlus size={16}/></button></form>
    <h3 className="text-sm font-semibold">Administrative Reviews</h3>{actions.map((action) => <div key={action.id} className="flex items-start justify-between gap-2 border-b border-border py-2"><div className="min-w-0"><code className="break-all text-xs">{JSON.stringify(action.action)}</code><p className="text-xs">{action.status} · Expires {new Date(action.expiresAt).toLocaleTimeString()}</p></div>
      {action.status === "pending" && <button className={icon} title="Review exact action" aria-label="Review exact action" disabled={busy} onClick={() => { setSelected(action); setPhrase(""); }}><Check size={16}/></button>}</div>)}</>}
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) { setSelected(null); setPassword(""); } }}>
    {selected && <DialogContent aria-describedby={undefined} className="max-h-[90vh] w-[calc(100%-2rem)] max-w-lg space-y-3 overflow-auto rounded p-5">
      <DialogTitle className="text-base font-semibold">Confirm Exact Action</DialogTitle><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify(selected.action, null, 2)}</pre><code className="block break-all text-xs">{selected.digest}</code>
      <p className="text-xs">Destructive operations may stop the computer and remove files. Active or unknown solver work blocks them.</p>
      <input className="w-full border border-border bg-background p-2" aria-label="Exact confirmation phrase" placeholder={"APPLY " + selected.id} value={phrase} onChange={(e) => setPhrase(e.target.value)}/>
      <input className="w-full border border-border bg-background p-2" aria-label="Your account password" placeholder="Your account password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}/>
      <div className="flex justify-end gap-2"><button className={icon} title="Cancel" aria-label="Cancel" onClick={() => { setSelected(null); setPassword(""); }}><X size={16}/></button>
        <button className={icon} title="Confirm action" aria-label="Confirm action" disabled={busy || phrase !== "APPLY " + selected.id || !password} onClick={() => void perform(async () => { const result = await api("confirm", { id: selected.id, digest: selected.digest, phrase, password }); setSelected(null); return result; })}><Check size={16}/></button></div>
    </DialogContent>}
    </Dialog>
    <h3 className="text-sm font-semibold">Cross-User Requests</h3>
    <form className="space-y-2" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      const signature=JSON.stringify([senderBot,recipient,recipientBot,message]);
      if (requestKey.current?.signature !== signature) requestKey.current={signature,key:crypto.randomUUID()};
      const result=await api("request", { botId: senderBot, recipientUserId: recipient, ...(recipientBot ? { recipientBotId: recipientBot } : {}), message, key: requestKey.current.key });
      requestKey.current=null;setMessage("");return result;
    }); }}>
      <div className="flex flex-wrap gap-2"><select className="min-w-0 flex-1 border border-border bg-background p-1" aria-label="Sender bot" value={senderBot} onChange={(e) => setSenderBot(e.target.value)} required><option value="">Your bot</option>{ownBots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
      <select className="min-w-0 flex-1 border border-border bg-background p-1" aria-label="Recipient member" value={recipient} onChange={(e) => { setRecipient(e.target.value); setRecipientBot(""); }} required><option value="">Recipient</option>{directory.filter((d) => d.userId !== view?.userId).map((d) => <option key={d.userId} value={d.userId}>{d.name}</option>)}</select>
      <select className="min-w-0 flex-1 border border-border bg-background p-1" aria-label="Recipient bot" value={recipientBot} onChange={(e) => setRecipientBot(e.target.value)}><option value="">Recipient chooses bot</option>{directory.find((d) => d.userId === recipient)?.bots?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></div>
      <textarea className="w-full border border-border bg-background p-2" aria-label="Request message" rows={3} maxLength={8000} required value={message} onChange={(e) => setMessage(e.target.value)}/><button className="border border-border px-3 py-1" disabled={busy}>Send request</button></form>
    {requests.map((request) => <div key={request.id} className="space-y-1 border-b border-border py-2"><p className="text-xs">{request.senderUserId} → {request.recipientUserId} · {request.status}</p><p className="whitespace-pre-wrap break-words">{request.message}</p>
      {request.status === "pending" && request.recipientUserId === view?.userId && <div className="flex flex-wrap gap-2"><select className="border border-border bg-background" aria-label="Receive in your bot" disabled={Boolean(request.recipientBotId)} value={request.recipientBotId ?? senderBot} onChange={(e) => setSenderBot(e.target.value)}><option value="">Your recipient bot</option>{ownBots.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        <input className="min-w-0 border border-border bg-background p-1" aria-label="Password to accept request" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)}/>
        <button className={icon} title="Accept and start recipient bot" aria-label="Accept and start recipient bot" disabled={busy || !password || !(request.recipientBotId ?? senderBot)} onClick={() => void perform(() => api("inbox/decide", { id: request.id, accept: true, botId: request.recipientBotId ?? senderBot, password }))}><Check size={16}/></button>
        <button className={icon} title="Reject request" aria-label="Reject request" disabled={busy || !password} onClick={() => void perform(() => api("inbox/decide", { id: request.id, accept: false, password }))}><X size={16}/></button></div>}</div>)}
    {view && <form className="flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); void perform(async () => {
      const joined = await api<{ spaceId: string }>("invite/accept", { token });
      if (!selectSpace(joined.spaceId)) throw new Error("Joined team; select the new workspace after refreshing.");
      window.location.reload();
    }); }}><input className="min-w-0 flex-1 border border-border bg-background p-1" aria-label="Private invitation token" placeholder="Invitation token" type="password" value={token} onChange={(e) => setToken(e.target.value)}/><button className="border border-border px-3 py-1" disabled={busy || !token}>Join team</button></form>}
  </section>;
}
