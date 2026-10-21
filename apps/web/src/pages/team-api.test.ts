import { afterEach, expect, it, vi } from "vitest";
vi.mock("../lib/rpc", () => ({ withSpaceHeaders: (headers: unknown) => headers }));
import { teamApi } from "./team-api";
afterEach(() => vi.unstubAllGlobals());
it("classifies disabled service without leaking a JSON parser exception", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ code: "TEAM_DISABLED" }, { status: 503 }));
  await expect(teamApi("overview")).rejects.toMatchObject({ disabled: true, message: expect.stringContaining("not enabled") });
});
it("handles text 404, HTML sign-in and malformed JSON safely", async () => {
  for (const response of [new Response("404 Not Found", { status: 404 }),
    new Response("<html>sign in</html>", { headers: { "content-type": "text/html" } }),
    new Response("oops", { headers: { "content-type": "application/json" } })]) {
    vi.stubGlobal("fetch", async () => response);
    await expect(teamApi("overview")).rejects.toMatchObject({ disabled: false, message: expect.not.stringContaining("SyntaxError") });
  }
});
it("returns authenticated data and handles expired sessions", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ members: [] }));
  expect(await teamApi("overview")).toEqual({ members: [] });
  vi.stubGlobal("fetch", async () => Response.json({ error: "private" }, { status: 401 }));
  await expect(teamApi("overview")).rejects.toThrow("sign in again");
});
