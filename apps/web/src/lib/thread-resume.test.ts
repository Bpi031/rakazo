// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { listenForThreadResume } from "./thread-resume";

afterEach(() => vi.restoreAllMocks());

it("recovers visible chats on focus, online, pageshow and visibility, with cleanup", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  const resume = vi.fn();
  const stop = listenForThreadResume(resume);
  for (const name of ["focus", "online", "pageshow"]) window.dispatchEvent(new Event(name));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(resume).toHaveBeenCalledTimes(4);
  stop();
  window.dispatchEvent(new Event("focus"));
  expect(resume).toHaveBeenCalledTimes(4);
});

it("does not fetch a suspended hidden chat", () => {
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  const resume = vi.fn();
  const stop = listenForThreadResume(resume);
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(resume).not.toHaveBeenCalled();
  stop();
});
