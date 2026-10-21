import { abortableDelay } from "@rakazo/core";
import { newClientId } from "./client-id";

type PageEvents = Pick<EventTarget, "addEventListener" | "removeEventListener">;
export const RPC_READ_TIMEOUT_MS = 15_000;
export const RPC_READ_RETRY_DELAY_MS = 250;
export const RPC_NAVIGATION_GRACE_MS = 10_000;
// Bootstrap is a read-only authenticated snapshot, not a job or conversation start.
const FINITE_READS = new Set([
  "/rpc/bootstrap",
  "/rpc/threads/get",
  "/rpc/threads/head",
  "/rpc/spaces/list",
]);

/** Retire a departing document's HTTP transport, not server-owned jobs. */
export function pageRpcTransport(page: PageEvents, performFetch: typeof fetch = fetch) {
  let hidden = false;
  let disposed = false;
  let navigationPending = false;
  let lifetime = new AbortController();
  let navigationTimer: ReturnType<typeof setTimeout> | undefined;
  const clearNavigationTimer = () => {
    clearTimeout(navigationTimer);
    navigationTimer = undefined;
  };
  const resume = () => {
    if (hidden || disposed) return;
    clearNavigationTimer();
    navigationPending = false;
    if (lifetime.signal.aborted) lifetime = new AbortController();
  };
  const leaving = (event: Event) => {
    if (hidden || disposed || navigationPending) return;
    navigationPending = true;
    lifetime.abort();
    // Inspect after all listeners: only a requested confirmation needs a cancelled-dialog fallback.
    navigationTimer = setTimeout(() => {
      navigationTimer = undefined;
      const value = (event as BeforeUnloadEvent).returnValue;
      if (hidden || disposed || !navigationPending) return;
      if (event.defaultPrevented || (typeof value === "string" && value !== ""))
        navigationTimer = setTimeout(resume, RPC_NAVIGATION_GRACE_MS);
    }, 0);
  };
  const hide = () => {
    clearNavigationTimer();
    hidden = true;
    lifetime.abort();
  };
  const show = () => {
    if (disposed) return;
    hidden = false;
    resume();
  };
  const interact = (event: Event) => {
    // A stopped navigation has no reliable event. Real input makes the surviving document usable.
    if (event.isTrusted && navigationPending) resume();
  };
  page.addEventListener("pagehide", hide);
  page.addEventListener("pageshow", show);
  page.addEventListener("beforeunload", leaving);
  page.addEventListener("pointerdown", interact);
  page.addEventListener("keydown", interact);
  return {
    async fetch(request: Request, init: RequestInit): Promise<Response> {
      if (hidden) throw new DOMException("Document is leaving", "AbortError");
      if (navigationPending) throw new DOMException("Document navigation pending", "AbortError");
      const captured = { ...init, headers: new Headers(init.headers ?? request.headers) };
      const path = new URL(request.url).pathname;
      const method = (captured.method ?? request.method).toUpperCase();
      const retryable = method === "POST" && captured.body == null && FINITE_READS.has(path);
      const signals = [request.signal, lifetime.signal];
      if (captured.signal) signals.push(captured.signal);
      if (retryable) signals.push(AbortSignal.timeout(RPC_READ_TIMEOUT_MS));
      const signal = AbortSignal.any(signals);
      signal.throwIfAborted();
      // Clone before fetch consumes the body; retries keep the exact space and request bytes.
      const backup = retryable ? request.clone() : null;
      let current = request;
      let retried = false;
      while (true) {
        const requestId = newClientId();
        const headers = new Headers(captured.headers);
        headers.set("x-request-id", requestId);
        try {
          const response = await performFetch(current, {
            ...captured,
            headers,
            signal,
          });
          if (retried)
            console.info(
              "Rakazo RPC recovered",
              JSON.stringify({
                at: new Date().toISOString(),
                endpoint: path,
                attempt: 2,
                status: response.status,
                requestId,
              }),
            );
          return response;
        } catch (error) {
          const retrying =
            backup != null && !retried && !signal.aborted && error instanceof TypeError;
          // Never log a URL, query, body, response, credential or raw error message.
          const name = error instanceof Error ? error.name : "unknown";
          const kind = ["AbortError", "TimeoutError", "TypeError", "Error"].includes(name)
            ? name
            : "other";
          const endpoint = [
            "/rpc/threads/get",
            "/rpc/threads/head",
            "/rpc/threads/subscribe",
            "/rpc/spaces/list",
            "/rpc/threads/markRead",
            "/rpc/computer/updates",
            "/rpc/bootstrap",
          ].includes(path)
            ? path
            : "other";
          const details = {
            at: new Date().toISOString(),
            documentStartedAtMs: performance.timeOrigin,
            endpoint,
            kind,
            aborted: signal.aborted,
            pageLeaving: hidden,
            navigationPending,
            navigationReadsPaused: navigationPending,
            online: typeof navigator === "undefined" ? null : navigator.onLine,
            visible:
              typeof document === "undefined" ? null : document.visibilityState === "visible",
            attempt: retried ? 2 : 1,
            retrying,
            requestId,
          };
          if (!signal.aborted) console.warn("Rakazo RPC transport", JSON.stringify(details));
          if (!retrying || !backup) throw error;
          retried = true;
          await abortableDelay(RPC_READ_RETRY_DELAY_MS, signal);
          signal.throwIfAborted();
          current = backup;
        }
      }
    },
    dispose() {
      disposed = true;
      page.removeEventListener("pagehide", hide);
      page.removeEventListener("pageshow", show);
      page.removeEventListener("beforeunload", leaving);
      page.removeEventListener("pointerdown", interact);
      page.removeEventListener("keydown", interact);
      hide();
    },
  };
}
