import { afterEach, expect, it, vi } from "vitest";
import {
  pageRpcTransport,
  RPC_NAVIGATION_GRACE_MS,
  RPC_READ_RETRY_DELAY_MS,
  RPC_READ_TIMEOUT_MS,
} from "./rpc-lifecycle";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("stops reads on page exit and accepts fresh reads after back-forward restoration", async () => {
  const page = new EventTarget();
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  const transport = pageRpcTransport(page, perform);
  const request = new Request("https://workspace.example.test/rpc/threads/get", { method: "POST" });
  await transport.fetch(request, { credentials: "include" });
  const first = perform.mock.calls[0]![1]!.signal!;
  page.dispatchEvent(new Event("pagehide"));
  expect(first.aborted).toBe(true);
  await expect(transport.fetch(request, {})).rejects.toMatchObject({ name: "AbortError" });
  expect(perform).toHaveBeenCalledTimes(1);
  page.dispatchEvent(new Event("pageshow"));
  await transport.fetch(request, {});
  expect(perform).toHaveBeenCalledTimes(2);
  expect(perform.mock.calls[1]![1]!.signal!.aborted).toBe(false);
  transport.dispose();
  page.dispatchEvent(new Event("pageshow"));
  await expect(transport.fetch(request, {})).rejects.toMatchObject({ name: "AbortError" });
});

it("preserves request options, caller cancellation and HTTP authorization errors", async () => {
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("no", { status: 401 }));
  const transport = pageRpcTransport(new EventTarget(), perform);
  const abort = new AbortController();
  const request = new Request("https://workspace.example.test/rpc/threads/get", {
    signal: abort.signal,
  });
  const response = await transport.fetch(request, {
    credentials: "include",
    headers: { "x-rakazo-space-id": "owned" },
  });
  expect(response.status).toBe(401);
  expect(perform).toHaveBeenCalledTimes(1);
  expect(perform.mock.calls[0]![1]).toMatchObject({
    credentials: "include",
  });
  expect(new Headers(perform.mock.calls[0]![1]?.headers).get("x-rakazo-space-id")).toBe("owned");
  abort.abort();
  expect(perform.mock.calls[0]![1]!.signal!.aborted).toBe(true);
  transport.dispose();
});

it("records bounded context and stops after one failed safe-read retry", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const error = new TypeError("secret-token-and-request-body");
  const perform = vi.fn<typeof fetch>().mockRejectedValue(error);
  const transport = pageRpcTransport(new EventTarget(), perform);
  const request = new Request("https://workspace.example.test/rpc/threads/get?secret=hidden", {
    body: "private",
    method: "POST",
  });
  await expect(transport.fetch(request, {})).rejects.toBe(error);
  expect(perform).toHaveBeenCalledTimes(2);
  expect(warning).toHaveBeenCalledWith("Rakazo RPC transport", expect.any(String));
  expect(JSON.parse(warning.mock.calls[0]![1] as string)).toMatchObject({
    endpoint: "/rpc/threads/get",
    kind: "TypeError",
    aborted: false,
    pageLeaving: false,
    attempt: 1,
    retrying: true,
  });
  expect(JSON.stringify(warning.mock.calls)).not.toMatch(
    /secret|hidden|private|workspace\.example/,
  );
  const firstId = JSON.parse(warning.mock.calls[0]![1] as string).requestId;
  expect(new Headers(perform.mock.calls[0]?.[1]?.headers).get("x-request-id")).toBe(firstId);
  const secondId = new Headers(perform.mock.calls[1]?.[1]?.headers).get("x-request-id");
  expect(firstId).toMatch(/^[a-f0-9-]{36}$/);
  expect(secondId).not.toBe(firstId);
  transport.dispose();
});

it.each(["bootstrap", "threads/get", "threads/head", "spaces/list"])(
  "recovers a dropped %s read with exact captured body and space",
  async (route) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const received: Array<{ body: string; space: string | null }> = [];
    const externalHeaders = new Headers({ "x-rakazo-space-id": "captured" });
    const perform = vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
      const request = input as Request;
      received.push({
        body: await request.text(),
        space: new Headers(init?.headers).get("x-rakazo-space-id"),
      });
      if (received.length === 1) {
        externalHeaders.set("x-rakazo-space-id", "changed-space");
        throw new TypeError("connection lost");
      }
      return Response.json({ ok: true });
    });
    const transport = pageRpcTransport(new EventTarget(), perform);
    const request = new Request("https://workspace.example.test/rpc/" + route, {
      method: "POST",
      body: '{"json":{"botId":"owned"}}',
    });
    const response = await transport.fetch(request, {
      credentials: "include",
      headers: externalHeaders,
    });
    expect(await response.json()).toEqual({ ok: true });
    expect(received).toEqual([
      { body: '{"json":{"botId":"owned"}}', space: "captured" },
      { body: '{"json":{"botId":"owned"}}', space: "captured" },
    ]);
    transport.dispose();
  },
);

it.each(["threads/send", "runs/stop", "routines/create", "repair/apply", "threads/subscribe"])(
  "never retries action or streaming endpoint %s",
  async (route) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new TypeError("connection lost");
    const perform = vi.fn<typeof fetch>().mockRejectedValue(error);
    const transport = pageRpcTransport(new EventTarget(), perform);
    const request = new Request("https://workspace.example.test/rpc/" + route, {
      method: "POST",
      body: "{}",
    });
    await expect(transport.fetch(request, {})).rejects.toBe(error);
    expect(perform).toHaveBeenCalledTimes(1);
    transport.dispose();
  },
);

it.each(
  [401, 403, 429, 500].flatMap((status) =>
    ["bootstrap", "spaces/list"].map((route) => ({ status, route })),
  ),
)("never retries an HTTP $status response from $route", async ({ status, route }) => {
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("error", { status }));
  const transport = pageRpcTransport(new EventTarget(), perform);
  const response = await transport.fetch(
    new Request("https://workspace.example.test/rpc/" + route, { method: "POST", body: "{}" }),
    {},
  );
  expect(response.status).toBe(status);
  expect(perform).toHaveBeenCalledTimes(1);
  transport.dispose();
});

it.each(["caller", "exit", "navigation"])(
  "cancels pending safe-read retry on %s",
  async (reason) => {
    vi.useFakeTimers();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const page = new EventTarget();
    const caller = new AbortController();
    const perform = vi.fn<typeof fetch>().mockRejectedValue(new TypeError("lost"));
    const transport = pageRpcTransport(page, perform);
    const running = transport.fetch(
      new Request("https://workspace.example.test/rpc/spaces/list", {
        method: "POST",
        body: "{}",
        signal: caller.signal,
      }),
      {},
    );
    const assertion = expect(running).rejects.toMatchObject({ name: "AbortError" });
    await vi.advanceTimersByTimeAsync(0);
    if (reason === "caller") caller.abort();
    else page.dispatchEvent(new Event(reason === "exit" ? "pagehide" : "beforeunload"));
    await assertion;
    await vi.advanceTimersByTimeAsync(RPC_READ_RETRY_DELAY_MS * 2);
    expect(perform).toHaveBeenCalledTimes(1);
    transport.dispose();
  },
);

it.each(["bootstrap", "spaces/list"])(
  "bounds a hung %s read without renewing its deadline",
  async (route) => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const perform = vi.fn<typeof fetch>().mockImplementation(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
    const transport = pageRpcTransport(new EventTarget(), perform);
    const running = transport.fetch(
      new Request("https://workspace.example.test/rpc/" + route, { method: "POST", body: "{}" }),
      {},
    );
    const assertion = expect(running).rejects.toMatchObject({ name: "TimeoutError" });
    deadline.abort(new DOMException("read deadline", "TimeoutError"));
    await assertion;
    expect(timeout).toHaveBeenCalledExactlyOnceWith(RPC_READ_TIMEOUT_MS);
    expect(perform).toHaveBeenCalledTimes(1);
    transport.dispose();
  },
);

it("shares the original total deadline across both read attempts", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const perform = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError("lost"))
    .mockImplementation(
      (_request, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        }),
    );
  const transport = pageRpcTransport(new EventTarget(), perform);
  const running = transport.fetch(
    new Request("https://workspace.example.test/rpc/spaces/list", { method: "POST", body: "{}" }),
    {},
  );
  const assertion = expect(running).rejects.toMatchObject({ name: "TimeoutError" });
  await vi.advanceTimersByTimeAsync(RPC_READ_RETRY_DELAY_MS);
  expect(perform).toHaveBeenCalledTimes(2);
  expect(perform.mock.calls[0]?.[1]?.signal).toBe(perform.mock.calls[1]?.[1]?.signal);
  deadline.abort(new DOMException("total deadline", "TimeoutError"));
  await assertion;
  expect(timeout).toHaveBeenCalledExactlyOnceWith(RPC_READ_TIMEOUT_MS);
  transport.dispose();
});

it.each([{ method: "PUT" }, { body: "non-replayable override" }])(
  "does not replay an overridden method or body: %j",
  async (override) => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = new TypeError("lost");
    const perform = vi.fn<typeof fetch>().mockRejectedValue(error);
    const transport = pageRpcTransport(new EventTarget(), perform);
    const request = new Request("https://workspace.example.test/rpc/spaces/list", {
      method: "POST",
      body: "{}",
    });
    await expect(transport.fetch(request, override)).rejects.toBe(error);
    expect(perform).toHaveBeenCalledTimes(1);
    transport.dispose();
  },
);

it.each([
  "threads/get",
  "threads/head",
  "spaces/list",
  "threads/subscribe",
  "threads/markRead",
  "computer/updates",
  "bootstrap",
  "threads/send",
])("pauses %s during provisional navigation and resumes on pageshow", async (route) => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = new EventTarget();
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  const transport = pageRpcTransport(page, perform);
  const request = () =>
    new Request("https://workspace.example.test/rpc/" + route, { method: "POST", body: "{}" });
  await transport.fetch(request(), {});
  const firstSignal = perform.mock.calls[0]![1]!.signal!;
  page.dispatchEvent(new Event("beforeunload"));
  expect(firstSignal.aborted).toBe(true);
  await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
  expect(perform).toHaveBeenCalledTimes(1);
  expect(warning).not.toHaveBeenCalled();
  page.dispatchEvent(new Event("pageshow"));
  expect((await transport.fetch(request(), {})).status).toBe(200);
  expect(perform.mock.calls[1]![1]!.signal!.aborted).toBe(false);
  transport.dispose();
});

it("recovers a cancelled navigation after a bounded grace period, not another read retry", async () => {
  vi.useFakeTimers();
  const page = new EventTarget();
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  const transport = pageRpcTransport(page, perform);
  const request = () => new Request("https://workspace.example.test/rpc/spaces/list");
  // A later listener can request a browser confirmation after our listener already ran.
  page.addEventListener("beforeunload", (event) => event.preventDefault());
  page.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(RPC_NAVIGATION_GRACE_MS - 1);
  await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
  expect(perform).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect((await transport.fetch(request(), {})).status).toBe(200);
  // A second navigation gets its own pause; a cancelled first navigation cannot disable it.
  page.dispatchEvent(new Event("beforeunload"));
  await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
  transport.dispose();
});

it.each(["exit", "dispose"])(
  "never revives a departed document on the grace timer: %s",
  async (reason) => {
    vi.useFakeTimers();
    const page = new EventTarget();
    const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const transport = pageRpcTransport(page, perform);
    page.dispatchEvent(new Event("beforeunload"));
    if (reason === "exit") page.dispatchEvent(new Event("pagehide"));
    else transport.dispose();
    await vi.advanceTimersByTimeAsync(RPC_NAVIGATION_GRACE_MS * 2);
    const request = () => new Request("https://workspace.example.test/rpc/spaces/list");
    await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
    expect(perform).not.toHaveBeenCalled();
    page.dispatchEvent(new Event("pageshow"));
    if (reason === "exit") expect((await transport.fetch(request(), {})).status).toBe(200);
    else await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
    transport.dispose();
  },
);

it("bounds repeated navigation events to one grace timer", async () => {
  vi.useFakeTimers();
  const page = new EventTarget();
  const transport = pageRpcTransport(page, vi.fn<typeof fetch>());
  page.addEventListener("beforeunload", (event) => event.preventDefault());
  page.dispatchEvent(new Event("beforeunload", { cancelable: true }));
  await vi.advanceTimersByTimeAsync(RPC_NAVIGATION_GRACE_MS / 2);
  page.dispatchEvent(new Event("beforeunload"));
  expect(vi.getTimerCount()).toBe(1);
  transport.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not reopen a normal slow reload after the old ten-second grace period", async () => {
  vi.useFakeTimers();
  const page = new EventTarget();
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  const transport = pageRpcTransport(page, perform);
  page.dispatchEvent(new Event("beforeunload"));
  await vi.advanceTimersByTimeAsync(RPC_NAVIGATION_GRACE_MS * 3);
  expect(vi.getTimerCount()).toBe(0);
  await expect(
    transport.fetch(new Request("https://workspace.example.test/rpc/computer/updates"), {}),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(perform).not.toHaveBeenCalled();
  page.dispatchEvent(new Event("pageshow"));
  expect(
    (await transport.fetch(new Request("https://workspace.example.test/rpc/computer/updates"), {}))
      .status,
  ).toBe(200);
  transport.dispose();
});

it.each(["pointerdown", "keydown"])(
  "restores a stopped navigation on real %s, not synthetic focus noise",
  async (name) => {
    vi.useFakeTimers();
    const page = new EventTarget();
    const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
    const transport = pageRpcTransport(page, perform);
    const request = () => new Request("https://workspace.example.test/rpc/computer/updates");
    page.dispatchEvent(new Event("beforeunload"));
    page.dispatchEvent(new Event("focus"));
    page.dispatchEvent(new Event(name));
    await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
    const realInput = new Event(name);
    Object.defineProperty(realInput, "isTrusted", { value: true });
    page.dispatchEvent(realInput);
    expect((await transport.fetch(request(), {})).status).toBe(200);
    expect(vi.getTimerCount()).toBe(0);
    transport.dispose();
  },
);

it("retires an action's HTTP acknowledgement without replaying it after navigation", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const page = new EventTarget();
  const perform = vi.fn<typeof fetch>().mockResolvedValue(new Response("ok"));
  const transport = pageRpcTransport(page, perform);
  const request = () =>
    new Request("https://workspace.example.test/rpc/threads/send", { method: "POST", body: "{}" });
  await transport.fetch(request(), {});
  const actionSignal = perform.mock.calls[0]![1]!.signal!;
  page.dispatchEvent(new Event("beforeunload"));
  expect(actionSignal.aborted).toBe(true);
  await expect(transport.fetch(request(), {})).rejects.toMatchObject({ name: "AbortError" });
  page.dispatchEvent(new Event("pageshow"));
  await vi.advanceTimersByTimeAsync(RPC_NAVIGATION_GRACE_MS * 2);
  expect(perform).toHaveBeenCalledTimes(1);
  expect(warning).not.toHaveBeenCalled();
  transport.dispose();
});

it("does not mislabel deliberate cancellation as a network outage", async () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const abort = new AbortController();
  const error = new DOMException("cancelled", "AbortError");
  const perform = vi.fn<typeof fetch>().mockImplementation(async () => {
    abort.abort();
    throw error;
  });
  const transport = pageRpcTransport(new EventTarget(), perform);
  await expect(
    transport.fetch(
      new Request("https://workspace.example.test/rpc/threads/subscribe", { signal: abort.signal }),
      {},
    ),
  ).rejects.toBe(error);
  expect(warning).not.toHaveBeenCalled();
  transport.dispose();
});
