import { Trans, useLingui } from "@lingui/react/macro";
import type {
  CallDoctor,
  CallRequestDoctorView,
  CallRequestInput,
  CallRequestManagerView,
  CallRequestRow,
  CallRequestType,
} from "@rakazo/contracts";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  Label,
  NativeSelect,
  NativeSelectOption,
  Skeleton,
} from "@rakazo/ui-web";
import {
  ArrowLeft,
  Check,
  Copy,
  Link2,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
  Users,
} from "lucide-react";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  CallRequestApiError,
  callMonthBounds,
  callMonthText,
  callRequestApi,
  currentCallMonth,
} from "../lib/call-requests";
import { CallDoctorDirectory } from "./CallDoctorDirectory";

function message(error: unknown): string {
  return error instanceof Error ? error.message : "The request could not be completed.";
}

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="h-full overflow-y-auto bg-background text-foreground">
      <div className="mx-auto w-full max-w-5xl space-y-7 px-4 py-7 sm:px-8 sm:py-10">
        {children}
      </div>
    </main>
  );
}

function MonthPicker({
  month,
  onChange,
  disabled,
}: {
  month: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useLingui();
  return (
    <Input
      type="month"
      aria-label={t`Request month`}
      className="w-44"
      min="1900-01"
      max="2199-12"
      value={month}
      disabled={disabled}
      onChange={(event) => {
        if (/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/.test(event.target.value))
          onChange(event.target.value);
      }}
    />
  );
}

function RequestType({ type }: { type: CallRequestType }) {
  if (type === "no_call") return <Trans>No call</Trans>;
  if (type === "prefer_call") return <Trans>Prefer call</Trans>;
  return <Trans>Others</Trans>;
}

function RequestEditor({
  month,
  row,
  busy,
  onCancel,
  onSave,
}: {
  month: string;
  row?: CallRequestRow;
  busy: boolean;
  onCancel?: () => void;
  onSave: (input: CallRequestInput) => Promise<void>;
}) {
  const { t } = useLingui();
  const [date, setDate] = useState(row?.date ?? "");
  const [type, setType] = useState<CallRequestType>(row?.type ?? "no_call");
  const [shift, setShift] = useState(row?.shift ?? "");
  const [text, setText] = useState(row?.text ?? "");
  const bounds = callMonthBounds(month);
  return (
    <form
      aria-label={row ? t`Edit request` : t`New request`}
      className="rounded-xl border border-border bg-card p-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!date || date.slice(0, 7) !== month || (type === "others" && !text.trim())) return;
        void onSave({
          ...(row ? { id: row.id } : {}),
          date,
          type,
          shift: shift.trim(),
          text: type === "others" ? text.trim() : "",
        });
      }}
    >
      <fieldset disabled={busy} className="flex min-w-0 flex-wrap items-end gap-3">
        <div className="min-w-36 flex-1 space-y-2">
          <Label htmlFor="call-date">
            <Trans>Date</Trans>
          </Label>
          <Input
            id="call-date"
            type="date"
            required
            min={bounds.min}
            max={bounds.max}
            value={date}
            onChange={(event) => setDate(event.target.value)}
          />
        </div>
        <div className="min-w-36 flex-1 space-y-2">
          <Label htmlFor="call-type">
            <Trans>Type</Trans>
          </Label>
          <NativeSelect
            id="call-type"
            className="w-full"
            value={type}
            onChange={(event) => setType(event.target.value as CallRequestType)}
          >
            <NativeSelectOption value="no_call">
              <Trans>No call</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="prefer_call">
              <Trans>Prefer call</Trans>
            </NativeSelectOption>
            <NativeSelectOption value="others">
              <Trans>Others</Trans>
            </NativeSelectOption>
          </NativeSelect>
        </div>
        <div className="min-w-32 flex-1 space-y-2">
          <Label htmlFor="call-shift">
            <Trans>Shift (optional)</Trans>
          </Label>
          <Input
            id="call-shift"
            maxLength={80}
            value={shift}
            onChange={(event) => setShift(event.target.value)}
          />
        </div>
        {type === "others" && (
          <div className="w-full space-y-2 sm:min-w-48 sm:flex-1">
            <Label htmlFor="call-text">
              <Trans>Request</Trans>
            </Label>
            <Input
              id="call-text"
              required
              maxLength={2000}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <Button type="submit" disabled={!date || (type === "others" && !text.trim())}>
            {row ? <Check size={16} /> : <Plus size={16} />}
            {row ? <Trans>Save</Trans> : <Trans>Add request</Trans>}
          </Button>
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel}>
              <Trans>Cancel</Trans>
            </Button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

export function DoctorCallRequestsPage() {
  const { spaceId = "" } = useParams();
  // Remounting separates pending requests and identity when navigating between clinics.
  return <DoctorRequests key={spaceId} spaceId={spaceId} />;
}

function DoctorRequests({ spaceId }: { spaceId: string }) {
  const { t } = useLingui();
  const base = `/${encodeURIComponent(spaceId)}`;
  const [month, setMonth] = useState(currentCallMonth);
  const [view, setView] = useState<CallRequestDoctorView | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedIn, setSignedIn] = useState(false);
  const [email, setEmail] = useState("");
  const [sentEmail, setSentEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setView(null);
    setEditing(null);
    setError("");
    void callRequestApi<CallRequestDoctorView>(`${base}?month=${month}`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        setView(result);
        setSignedIn(true);
      })
      .catch((reason) => {
        if (controller.signal.aborted) return;
        if (reason instanceof CallRequestApiError && reason.status === 401) setSignedIn(false);
        else setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [base, month, revision]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (reason) {
      if (!lifetime.current.signal.aborted) {
        setError(
          reason instanceof CallRequestApiError && reason.status === 503
            ? t`Doctor sign-in is unavailable. Contact your administrator.`
            : message(reason),
        );
        if (reason instanceof CallRequestApiError && reason.status === 401) {
          setSignedIn(false);
          setView(null);
        }
      }
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }

  const sendCode = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await callRequestApi(`${base}/code`, { body: { email }, signal: lifetime.current.signal });
      setSentEmail(email.trim().toLowerCase());
      setCode("");
      setNotice(t`If your email is registered, a verification code has been sent.`);
    });
  };
  const verify = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      await callRequestApi(`${base}/verify`, {
        body: { email: sentEmail, code },
        signal: lifetime.current.signal,
      });
      setCode("");
      setSentEmail("");
      setSignedIn(true);
      setRevision((value) => value + 1);
    });
  };
  async function save(input: CallRequestInput) {
    await run(async () => {
      await callRequestApi(`${base}/requests`, { body: input, signal: lifetime.current.signal });
      setRevision((value) => value + 1);
    });
  }
  return (
    <Page>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            <Trans>Call requests</Trans>
          </h1>
          {view && <p className="mt-2 text-sm text-muted-foreground">{view.doctor.name}</p>}
        </div>
        {signedIn && (
          <Button
            variant="ghost"
            disabled={busy || loading}
            onClick={() =>
              void run(async () => {
                await callRequestApi(`${base}/logout`, {
                  body: {},
                  signal: lifetime.current.signal,
                });
                setView(null);
                setSignedIn(false);
                setEmail("");
                setSentEmail("");
                setCode("");
              })
            }
          >
            <Trans>Sign out</Trans>
          </Button>
        )}
      </header>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          <Trans>Loading…</Trans>
        </p>
      ) : !signedIn ? (
        <section className="max-w-sm space-y-5">
          <form className="space-y-3" onSubmit={sendCode}>
            <Label htmlFor="doctor-email">
              <Trans>Registered email</Trans>
            </Label>
            <Input
              id="doctor-email"
              type="email"
              autoComplete="email"
              required
              maxLength={254}
              value={email}
              disabled={busy}
              onChange={(event) => {
                setEmail(event.target.value);
                setSentEmail("");
                setCode("");
                setNotice("");
              }}
            />
            <Button type="submit" disabled={busy || !email.trim()}>
              <Trans>Send code</Trans>
            </Button>
          </form>
          {sentEmail && (
            <form className="space-y-3" onSubmit={verify}>
              <Label htmlFor="doctor-code">
                <Trans>Verification code</Trans>
              </Label>
              <Input
                id="doctor-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                value={code}
                disabled={busy}
                onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
              />
              <Button type="submit" disabled={busy || code.length !== 6}>
                <Trans>Verify</Trans>
              </Button>
            </form>
          )}
        </section>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <MonthPicker month={month} disabled={busy} onChange={setMonth} />
            {view && (
              <span className="text-sm tabular-nums text-muted-foreground">
                {view.requests.length} / {view.limit}
              </span>
            )}
          </div>
          {view && (
            <div className="space-y-3">
              {view.requests.map((row) =>
                editing === row.id ? (
                  <RequestEditor
                    key={row.id}
                    row={row}
                    month={month}
                    busy={busy}
                    onCancel={() => setEditing(null)}
                    onSave={save}
                  />
                ) : (
                  <div
                    key={row.id}
                    className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border px-4 py-3 text-sm"
                  >
                    <time className="tabular-nums">{row.date}</time>
                    <span className="font-medium">
                      <RequestType type={row.type} />
                    </span>
                    {row.shift && <span className="text-muted-foreground">{row.shift}</span>}
                    {row.text && <span className="min-w-0 flex-1 break-words">{row.text}</span>}
                    <div className="ml-auto flex shrink-0 gap-1">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Edit request for ${row.date}`}
                        disabled={busy}
                        onClick={() => setEditing(row.id)}
                      >
                        <Pencil size={15} />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t`Delete request for ${row.date}`}
                        disabled={busy}
                        onClick={() =>
                          void run(async () => {
                            await callRequestApi(
                              `${base}/requests/${encodeURIComponent(row.id)}/delete`,
                              { body: {}, signal: lifetime.current.signal },
                            );
                            setRevision((value) => value + 1);
                          })
                        }
                      >
                        <Trash2 size={15} />
                      </Button>
                    </div>
                  </div>
                ),
              )}
              {!editing && view.requests.length < view.limit && (
                <RequestEditor
                  key={`${month}:${revision}`}
                  month={month}
                  busy={busy}
                  onSave={save}
                />
              )}
              {!editing && view.requests.length >= view.limit && (
                <p className="text-sm text-muted-foreground">
                  <Trans>Monthly limit reached.</Trans>
                </p>
              )}
            </div>
          )}
        </>
      )}
    </Page>
  );
}

export function ManagerCallRequestsPage() {
  const { t } = useLingui();
  const [month, setMonth] = useState(currentCallMonth);
  const [loaded, setLoaded] = useState<{ month: string; view: CallRequestManagerView } | null>(
    null,
  );
  const view = loaded?.month === month ? loaded.view : null;
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [doctorsOpen, setDoctorsOpen] = useState(false);
  const [copied, setCopied] = useState<"table" | "link" | null>(null);
  const [revision, setRevision] = useState(0);
  const lifetime = useRef(new AbortController());
  const requestMonth = useRef(month);
  requestMonth.current = month;
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(null), 1800);
    return () => window.clearTimeout(timeout);
  }, [copied]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError("");
    setCopied(null);
    void callRequestApi<CallRequestManagerView>(`/manage?month=${month}`, {
      manager: true,
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setLoaded({ month, view: result });
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(message(reason));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [month, revision]);

  const run = useCallback(async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    setCopied(null);
    try {
      await action();
    } catch (reason) {
      if (!lifetime.current.signal.aborted) setError(message(reason));
    } finally {
      if (!lifetime.current.signal.aborted) setBusy(false);
    }
  }, []);

  async function copyMonth() {
    await run(async () => {
      const targetMonth = month;
      const latest = await callRequestApi<CallRequestManagerView>(`/manage?month=${targetMonth}`, {
        manager: true,
        signal: lifetime.current.signal,
      });
      if (requestMonth.current !== targetMonth) return;
      await navigator.clipboard.writeText(callMonthText(targetMonth, latest.requests));
      setLoaded({ month: targetMonth, view: latest });
      setCopied("table");
    });
  }

  async function saveDoctors(
    doctors: Array<Pick<CallDoctor, "code" | "name" | "email" | "active">>,
  ) {
    await callRequestApi("/manage/doctors", {
      manager: true,
      body: { doctors },
      signal: lifetime.current.signal,
    });
    const targetMonth = requestMonth.current;
    const latest = await callRequestApi<CallRequestManagerView>(`/manage?month=${targetMonth}`, {
      manager: true,
      signal: lifetime.current.signal,
    });
    if (requestMonth.current === targetMonth) setLoaded({ month: targetMonth, view: latest });
  }

  return (
    <Page>
      <header className="flex items-center gap-3">
        <Link
          to="/app"
          aria-label={t`Back to Agents`}
          className="-ml-2 inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <ArrowLeft size={18} />
        </Link>
        <h1 className="min-w-0 flex-1 text-xl font-semibold tracking-tight">
          <Trans>Call requests</Trans>
        </h1>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={t`More actions`}
                disabled={!view || busy}
              />
            }
          >
            {copied === "link" ? <Check size={19} /> : <MoreHorizontal size={19} />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => setDoctorsOpen(true)}>
              <Users size={16} />
              <Trans>Manage doctors</Trans>
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                void run(async () => {
                  if (!view) return;
                  if (!view.emailDelivery)
                    throw new Error(t`Doctor sign-in is unavailable. Contact your administrator.`);
                  await navigator.clipboard.writeText(
                    new URL(
                      `/call-requests/${encodeURIComponent(view.spaceId)}`,
                      window.location.origin,
                    ).href,
                  );
                  setCopied("link");
                })
              }
            >
              <Link2 size={16} />
              <Trans>Copy doctor link</Trans>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </header>
      <div className="flex items-center justify-between gap-3">
        <MonthPicker month={month} disabled={busy} onChange={setMonth} />
        <Button
          aria-label={t`Copy month table`}
          disabled={!view || busy}
          onClick={() => void copyMonth()}
        >
          {copied === "table" ? <Check size={15} /> : <Copy size={15} />}
          {copied === "table" ? <Trans>Copied</Trans> : <Trans>Copy month table</Trans>}
        </Button>
      </div>
      {copied && (
        <span role="status" className="sr-only">
          <Trans>Copied</Trans>
        </span>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!view && loading ? (
        <div role="status" aria-label={t`Loading…`} className="space-y-3 py-5">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      ) : view?.requests.length ? (
        <div className="overflow-x-auto" aria-busy={loading}>
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr>
                <th className="py-3 pr-3 font-medium">
                  <Trans>Doctor</Trans>
                </th>
                <th className="py-3 pr-3 font-medium">
                  <Trans>Date</Trans>
                </th>
                <th className="py-3 pr-3 font-medium">
                  <Trans>Request</Trans>
                </th>
                <th className="w-9">
                  <span className="sr-only">
                    <Trans>Actions</Trans>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {view.requests.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-4 pr-3 align-top">{row.doctorName}</td>
                  <td className="whitespace-nowrap py-4 pr-3 align-top tabular-nums">{row.date}</td>
                  <td className="min-w-24 py-4 pr-3 align-top">
                    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                      <span>
                        <RequestType type={row.type} />
                      </span>
                      {row.shift && <span className="text-muted-foreground">{row.shift}</span>}
                    </div>
                    {row.text && (
                      <p className="mt-1 break-words text-muted-foreground">{row.text}</p>
                    )}
                  </td>
                  <td className="py-3 align-top">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      disabled={busy || loading}
                      aria-label={t`Delete request from ${row.doctorName} for ${row.date}`}
                      onClick={() =>
                        void run(async () => {
                          await callRequestApi(
                            `/manage/requests/${encodeURIComponent(row.id)}/delete`,
                            { manager: true, body: {}, signal: lifetime.current.signal },
                          );
                          setRevision((value) => value + 1);
                        })
                      }
                    >
                      <Trash2 size={15} />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view ? (
        <p className="py-20 text-center text-sm text-muted-foreground">
          <Trans>No requests this month.</Trans>
        </p>
      ) : null}
      {view && (
        <CallDoctorDirectory
          open={doctorsOpen}
          onOpenChange={setDoctorsOpen}
          doctors={view.doctors}
          onSave={saveDoctors}
        />
      )}
    </Page>
  );
}
