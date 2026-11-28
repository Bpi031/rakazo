import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRightPanelState,
  rightPanelStorageKey,
  writeRightPanelState,
} from "./right-panel-state";

afterEach(() => vi.unstubAllGlobals());
describe("right panel preferences", () => {
  it("round trips closed state and only the selected routine reference", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    writeRightPanelState("user-a:space-a:bot-a", "routine", "routine-a");
    expect(readRightPanelState("user-a:space-a:bot-a")).toEqual({
      panel: "routine",
      routineId: "routine-a",
    });
    expect(readRightPanelState("user-b:space-a:bot-a")).toEqual({ panel: null });
    writeRightPanelState("user-a:space-a:bot-a", null, "routine-a");
    expect(readRightPanelState("user-a:space-a:bot-a")).toEqual({ panel: null });
  });
  it.each(["routines", "pages"])("reopens a stored %s view on the bot's panel", (panel) => {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify({ panel }) });
    expect(readRightPanelState("state")).toEqual({ panel: "settings" });
  });
  it.each([
    "not json",
    "null",
    "[]",
    '{"panel":"unknown"}',
    '{"panel":{}}',
    '{"panel":"create"}',
    '{"panel":"priorities"}',
    '{"panel":"create-group"}',
  ])("ignores malformed preference %s", (value) => {
    vi.stubGlobal("localStorage", { getItem: () => value });
    expect(readRightPanelState("state")).toEqual({ panel: null });
  });
  it("keeps working when browser storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    });
    expect(readRightPanelState("state")).toEqual({ panel: null });
    expect(() => writeRightPanelState("state", "settings")).not.toThrow();
  });
  it("skips the ephemeral create-group panel and builds scoped keys", () => {
    const entries = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => entries.get(key) ?? null,
      setItem: (key: string, value: string) => entries.set(key, value),
    });
    const key = rightPanelStorageKey("user-a", "space-a", "bot", "bot-a");
    expect(key).toBe("rakazo:right-panel-state:user-a:space-a:bot:bot-a");
    writeRightPanelState(key, "computer");
    writeRightPanelState(key, "create");
    expect(readRightPanelState(key)).toEqual({ panel: "computer" });
    writeRightPanelState(key, "checkpoints");
    expect(readRightPanelState(key)).toEqual({ panel: "checkpoints" });
    writeRightPanelState(key, "create-group");
    expect(readRightPanelState(key)).toEqual({ panel: "checkpoints" });
  });
});
