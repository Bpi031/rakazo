import type { ProductEvent } from "@rakazo/contracts";
import { abortableDelay } from "./async.js";

type ThreadHead = { threadId: string; cursor: number };

/** No frame at all for this long means the stream is half-open; the server beats far faster. */
export const IDLE_TIMEOUT_MS = 45_000;
export const HEAD_RECHECK_MS = 30_000;

/** Recover a durable event stream while its caller owns snapshot commits and UI effects. */
export async function runThreadSubscription(options: {
  signal: AbortSignal;
  loadInitial: () => Promise<ThreadHead | null>;
  loadHead: () => Promise<ThreadHead | null>;
  refresh: () => Promise<unknown>;
  currentSnapshot: () => ThreadHead | null;
  subscribe: (cursor: number, signal: AbortSignal) => Promise<AsyncIterable<ProductEvent>>;
  listenForResume?: (resume: () => void) => () => void;
  isForeground?: () => boolean;
  beforeEvent?: (event: ProductEvent) => void;
  applyEvent: (event: ProductEvent) => void;
  onEvent: (event: ProductEvent, initial: ThreadHead) => void;
}): Promise<void> {
  const { signal } = options;
  let resumePending = false;
  let wake: (() => void) | undefined;
  const unlisten = options.listenForResume?.(() => {
    resumePending = true;
    wake?.();
  });
  const abortWake = () => wake?.();
  signal.addEventListener("abort", abortWake);
  try {
    const wait = async (ms: number) => {
      await abortableDelay(ms, signal);
      return !signal.aborted;
    };
    let initial = await options.loadInitial().catch(() => null);
    if (signal.aborted) return;
    let headRetryMs = 250;
    while (!initial && !signal.aborted) {
      initial = await options.loadHead().catch(() => null);
      if (initial) break;
      if (!(await wait(headRetryMs))) return;
      headRetryMs = Math.min(headRetryMs * 2, 5_000);
    }
    if (!initial || signal.aborted) return;
    const head = initial;
    let cursor = head.cursor;
    let snapshotReady = options.currentSnapshot()?.threadId === head.threadId;
    const pendingSnapshotEvents: ProductEvent[] = [];
    if (!snapshotReady) {
      void (async () => {
        let snapshotRetryMs = 250;
        while (!snapshotReady && !signal.aborted) {
          if (!(await wait(snapshotRetryMs))) return;
          await options.refresh().catch(() => null);
          if (signal.aborted) return;
          const committed = options.currentSnapshot();
          if (committed?.threadId === head.threadId) {
            snapshotReady = true;
            for (const event of pendingSnapshotEvents.splice(0)) {
              if (event.seq > committed.cursor) options.applyEvent(event);
            }
            return;
          }
          snapshotRetryMs = Math.min(snapshotRetryMs * 2, 5_000);
        }
      })();
    }
    let retryMs = 250;
    while (!signal.aborted) {
      const attempt = new AbortController();
      const streamSignal = AbortSignal.any([signal, attempt.signal]);
      try {
        // A suspended browser can keep receiving heartbeats after losing data frames.
        // Reconcile durable state independently of socket liveness.
        if (resumePending) {
          resumePending = false;
          await options.refresh().catch(() => null);
        }
        const committed = options.currentSnapshot();
        if (committed?.threadId === head.threadId) cursor = Math.max(cursor, committed.cursor);
        let headCheckAt = Date.now() + HEAD_RECHECK_MS;
        let idleAt = Date.now() + IDLE_TIMEOUT_MS;
        const interruptible = async <T>(pending: Promise<T>): Promise<T | "wake" | "timer"> => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return Promise.race([
            pending,
            new Promise<"wake">((resolve) => {
              wake = () => resolve("wake");
              if (signal.aborted || resumePending) resolve("wake");
            }),
            new Promise<"timer">((resolve) => {
              timer = setTimeout(
                () => resolve("timer"),
                Math.max(0, Math.min(idleAt, headCheckAt) - Date.now()),
              );
            }),
          ]).finally(() => {
            clearTimeout(timer);
            wake = undefined;
          });
        };
        const opened = await interruptible(options.subscribe(cursor, streamSignal));
        if (opened === "wake" || opened === "timer") {
          // A connection that never opens still needs snapshot catch-up and backoff.
          throw new Error("Thread stream opening interrupted");
        }
        const events = opened;
        const iterator = events[Symbol.asyncIterator]();
        try {
          let pending: Promise<IteratorResult<ProductEvent>> | undefined;
          while (!signal.aborted) {
            pending ??= iterator.next();
            const next = await interruptible(pending);
            if (next === "wake" || next === "timer") {
              resumePending = false;
              if (Date.now() >= idleAt) break;
              headCheckAt = Date.now() + HEAD_RECHECK_MS;
              if (options.isForeground?.() === false) continue;
              const latest = await options.loadHead().catch(() => null);
              if (signal.aborted) return;
              const snapshot = options.currentSnapshot();
              if (
                latest?.threadId === head.threadId &&
                (!snapshot ||
                  snapshot.threadId !== head.threadId ||
                  latest.cursor > snapshot.cursor)
              ) {
                break;
              }
              continue;
            }
            if (next.done) break;
            pending = undefined;
            idleAt = Date.now() + IDLE_TIMEOUT_MS;
            const event = next.value;
            retryMs = 250;
            // Heartbeats only prove the socket is alive; they carry no state and no cursor.
            if (event.type === "heartbeat") continue;
            cursor = Math.max(cursor, event.seq);
            options.beforeEvent?.(event);
            if (snapshotReady && options.currentSnapshot()?.threadId === event.threadId) {
              options.applyEvent(event);
            } else if (!snapshotReady) {
              pendingSnapshotEvents.push(event);
            }
            options.onEvent(event, head);
          }
        } finally {
          // Not awaited: a half-open iterator can take as long to close as it took to go quiet.
          void iterator.return?.(undefined).catch(() => {});
        }
      } catch {
        // Reconnect from the last durable event after a transient transport failure.
      } finally {
        // Abort the old HTTP read as well as abandoning its iterator.
        attempt.abort();
      }
      if (signal.aborted) return;
      resumePending = false;
      await options.refresh().catch(() => null);
      if (!(await wait(retryMs))) return;
      retryMs = Math.min(retryMs * 2, 5_000);
    }
  } finally {
    unlisten?.();
    signal.removeEventListener("abort", abortWake);
  }
}
