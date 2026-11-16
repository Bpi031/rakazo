import type { CallRequestRow } from "@rakazo/contracts";
import { afterEach, expect, it, vi } from "vitest";
import {
  CallRequestApiError,
  callMonthBounds,
  callMonthText,
  callRequestApi,
} from "./call-requests";

vi.mock("./rpc", () => ({
  withSpaceHeaders: (headers: Headers) => {
    const next = new Headers(headers);
    next.set("x-rakazo-space-id", "selected-space");
    return next;
  },
}));
afterEach(() => vi.unstubAllGlobals());

it("doctor calls do not inherit the Rakazo space selection; Manager calls do", async () => {
  const fetch = vi.fn().mockImplementation(async () => Response.json({ ok: true }));
  vi.stubGlobal("fetch", fetch);
  await callRequestApi("/clinic/code", { body: { email: "doctor@example.test" } });
  await callRequestApi("/manage?month=2026-11", { manager: true });
  const doctorOptions = fetch.mock.calls[0]![1] as RequestInit;
  const managerOptions = fetch.mock.calls[1]![1] as RequestInit;
  expect(new Headers(doctorOptions.headers).has("x-rakazo-space-id")).toBe(false);
  expect(new Headers(managerOptions.headers).get("x-rakazo-space-id")).toBe("selected-space");
  expect(doctorOptions).toMatchObject({
    credentials: "include",
    cache: "no-store",
    method: "POST",
  });
});

it("keeps authorization errors distinct and rejects a non-JSON proxy response", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(Response.json({ error: "Sign in required" }, { status: 401 }))
      .mockResolvedValueOnce(new Response("<html>Proxy failed</html>", { status: 502 })),
  );
  await expect(callRequestApi("/clinic")).rejects.toMatchObject({
    status: 401,
    message: "Sign in required",
  });
  await expect(callRequestApi("/clinic")).rejects.toBeInstanceOf(CallRequestApiError);
});

it("copy preserves hard constraints, stable doctor identity and single-line table cells", () => {
  const row: CallRequestRow = {
    id: "r",
    doctorId: "d",
    doctorCode: "D01",
    doctorName: "Doctor One",
    date: "2026-11-04",
    type: "no_call",
    shift: "Night",
    text: "",
    createdAt: "",
    updatedAt: "",
  };
  const text = callMonthText("2026-11", [
    row,
    { ...row, id: "second", date: "2026-11-02", type: "others", text: "One\nline\trequest" },
  ]);
  expect(text).toContain("hard constraints");
  expect(text).toContain("confirming infeasibility");
  expect(text).toContain("Manager confirmation");
  expect(text).toContain("D01\tDoctor One\t2026-11-04\tNo call\tNight\t");
  expect(text).toContain("One line request");
  expect(text.indexOf("2026-11-02")).toBeLessThan(text.indexOf("2026-11-04"));
});

it("month bounds include leap-day without UTC day rollover", () => {
  expect(callMonthBounds("2028-02")).toEqual({ min: "2028-02-01", max: "2028-02-29" });
  expect(callMonthBounds("2026-11").max).toBe("2026-11-30");
});
