import type { ProductEvent } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HEAD_RECHECK_MS, IDLE_TIMEOUT_MS, runThreadSubscription } from "./thread-subscription.js";

const head = { threadId: "thread", cursor: 10 };
function event(seq: number): ProductEvent {
  return {
    id: `event-${seq}`,
    spaceId: "space",
    threadId: "thread",
    botId: "bot",
    seq,
    type: "thread.progress",
    payload: {},
    createdAt: "2026-01-01T00:00:00Z",
  };
}
function heartbeat(): ProductEvent {
  return { ...event(0), id: "heartbeat", type: "heartbeat" };
}
function stream() {
  let deliver: ((result: IteratorResult<ProductEvent>) => void) | undefined;
  const events: AsyncIterable<ProductEvent> = {
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          new Promise((resolve) => {
            deliver = resolve;
          }),
      };
    },
  };
  return {
    events,
    send: (value: ProductEvent) => deliver?.({ value, done: false }),
    end: () => deliver?.({ value: undefined, done: true }),
  };
}
function setup(committed: typeof head | null = head) {
  const abort = new AbortController();
  const channel = stream();
  const state = { committed };
  const callbacks = {
    signal: abort.signal,
    loadInitial: vi.fn(async () => head as typeof head | null),
    loadHead: vi.fn(async () => head as typeof head | null),
    refresh: vi.fn(async () => {}),
    currentSnapshot: () => state.committed,
    subscribe: vi.fn(async (_cursor: number, _signal: AbortSignal) => channel.events),
    applyEvent: vi.fn(),
    onEvent: vi.fn(),
  };
  return { abort, channel, state, callbacks };
}
afterEach(() => vi.useRealTimers());

describe("thread subscription recovery", () => {
  it("falls back to head with backoff and buffers until a snapshot commits", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup(null);
    callbacks.loadInitial.mockResolvedValue(null);
    callbacks.loadHead.mockResolvedValueOnce(null);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 11 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(2);
    expect(callbacks.subscribe).toHaveBeenCalledWith(10, expect.any(AbortSignal));
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("reconnects from the highest event cursor and resets backoff after delivery", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    callbacks.subscribe.mockRejectedValueOnce(new Error("offline"));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(250);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 10, 12]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(2);
    expect(callbacks.onEvent).toHaveBeenLastCalledWith(event(11), head);
    abort.abort();
    channel.end();
    await running;
  });

  it("cancels a reconnect delay without rejecting or starting another request", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.end();
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    await expect(running).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps receipt handling before applying events and effects afterward", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const order: string[] = [];
    callbacks.applyEvent.mockImplementation(() => {
      order.push("apply");
    });
    callbacks.onEvent.mockImplementation(() => {
      order.push("effect");
    });
    const running = runThreadSubscription({
      ...callbacks,
      beforeEvent: () => {
        order.push("receipt");
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(order).toEqual(["receipt", "apply", "effect"]);
    abort.abort();
    channel.end();
    await running;
  });

  it("does not refresh or replay a buffered event after cancellation during snapshot delay", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup(null);
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    abort.abort();
    channel.end();
    await running;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
  });

  it("ignores a late initial response after switching away", async () => {
    const { abort, callbacks } = setup();
    let resolve!: (value: typeof head) => void;
    callbacks.loadInitial.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const running = runThreadSubscription(callbacks);
    abort.abort();
    resolve(head);
    await running;
    expect(callbacks.subscribe).not.toHaveBeenCalled();
    expect(callbacks.loadHead).not.toHaveBeenCalled();
  });

  it("skips displaced-snapshot events while retaining effects and subsequent live updates", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    state.committed = { threadId: "replacement-thread", cursor: 0 };
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).toHaveBeenCalledWith(event(11), head);
    state.committed = head;
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(12));
    expect(callbacks.refresh).not.toHaveBeenCalled();
    abort.abort();
    channel.end();
    await running;
  });

  it("swallows heartbeats without applying them or advancing the cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).not.toHaveBeenCalled();
    expect(callbacks.onEvent).not.toHaveBeenCalled();
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    abort.abort();
    channel.end();
    await running;
  });

  it("abandons a silent stream and resubscribes from the same cursor", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS);
    expect(abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 11]);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    channel.send(event(12));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent.mock.calls.map(([item]) => item.seq)).toEqual([11, 12]);
    abort.abort();
    channel.end();
    await running;
  });

  it("keeps a heartbeat alive as liveness so the idle timer never fires", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    for (let beat = 0; beat < 3; beat += 1) {
      await vi.advanceTimersByTimeAsync(IDLE_TIMEOUT_MS - 1_000);
      channel.send(heartbeat());
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    abort.abort();
    channel.end();
    await running;
  });

  it("catches up durable completion even when a stale stream still sends heartbeats", async () => {
    vi.useFakeTimers();
    const { abort, channel, state, callbacks } = setup();
    callbacks.loadHead.mockResolvedValue({ ...head, cursor: 120 });
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 120 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    const firstSignal = callbacks.subscribe.mock.calls[0]![1];
    await vi.advanceTimersByTimeAsync(HEAD_RECHECK_MS - 1_000);
    channel.send(heartbeat());
    await vi.advanceTimersByTimeAsync(1_250);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    expect(firstSignal.aborted).toBe(true);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 120]);
    abort.abort();
    await running;
  });

  it("recovers on browser resume after six hours without sending a new turn", async () => {
    vi.useFakeTimers();
    const { abort, state, callbacks } = setup();
    let resume!: () => void;
    const unlisten = vi.fn();
    const running = runThreadSubscription({
      ...callbacks,
      isForeground: () => false,
      listenForResume: (listener) => {
        resume = listener;
        return unlisten;
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 500 };
    });
    vi.setSystemTime(Date.now() + 6 * 60 * 60_000);
    resume();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 500]);
    abort.abort();
    await running;
    expect(unlisten).toHaveBeenCalledOnce();
  });

  it("cancels a blocked connection open and retires its HTTP signal", async () => {
    vi.useFakeTimers();
    const { abort, callbacks } = setup();
    callbacks.subscribe.mockImplementationOnce(() => new Promise(() => {}));
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(0);
    const streamSignal = callbacks.subscribe.mock.calls[0]![1];
    abort.abort();
    await running;
    expect(streamSignal.aborted).toBe(true);
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
  });

  it("checks durable state on repeated focus without cancelling a healthy stream", async () => {
    vi.useFakeTimers();
    const { abort, channel, callbacks } = setup();
    let resume!: () => void;
    const running = runThreadSubscription({
      ...callbacks,
      listenForResume: (listener) => {
        resume = listener;
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    const streamSignal = callbacks.subscribe.mock.calls[0]![1];
    resume();
    resume();
    resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.loadHead).toHaveBeenCalledTimes(1);
    expect(callbacks.refresh).not.toHaveBeenCalled();
    expect(callbacks.subscribe).toHaveBeenCalledTimes(1);
    expect(streamSignal.aborted).toBe(false);
    channel.send(event(11));
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.applyEvent).toHaveBeenCalledExactlyOnceWith(event(11));
    abort.abort();
    await running;
  });

  it("recovers missed data on focus even if the stream is still alive", async () => {
    vi.useFakeTimers();
    const { abort, state, callbacks } = setup();
    let resume!: () => void;
    callbacks.loadHead.mockResolvedValue({ ...head, cursor: 15 });
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 15 };
    });
    const running = runThreadSubscription({
      ...callbacks,
      listenForResume: (listener) => {
        resume = listener;
        return () => {};
      },
    });
    await vi.advanceTimersByTimeAsync(0);
    resume();
    await vi.advanceTimersByTimeAsync(250);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 15]);
    abort.abort();
    await running;
  });

  it("refreshes after a stalled open instead of repeatedly opening without catch-up", async () => {
    vi.useFakeTimers();
    const { abort, state, callbacks } = setup();
    callbacks.subscribe.mockImplementationOnce(() => new Promise(() => {}));
    callbacks.refresh.mockImplementation(async () => {
      state.committed = { ...head, cursor: 22 };
    });
    const running = runThreadSubscription(callbacks);
    await vi.advanceTimersByTimeAsync(HEAD_RECHECK_MS + 250);
    expect(callbacks.refresh).toHaveBeenCalledTimes(1);
    expect(callbacks.subscribe.mock.calls.map(([cursor]) => cursor)).toEqual([10, 22]);
    expect(callbacks.subscribe.mock.calls[0]![1].aborted).toBe(true);
    abort.abort();
    await running;
  });
});
