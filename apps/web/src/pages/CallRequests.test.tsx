// @vitest-environment jsdom
import type {
  CallRequestDoctorView,
  CallRequestManagerView,
  CallRequestRow,
} from "@rakazo/contracts";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CallRequestApiError, callRequestApi } from "../lib/call-requests";
import { DoctorCallRequestsPage, ManagerCallRequestsPage } from "./CallRequests";

vi.mock("../lib/call-requests", async (original) => ({
  ...(await original<object>()),
  callRequestApi: vi.fn(),
  currentCallMonth: () => "2026-11",
}));
vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: any) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((s, part, i) => s + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  DropdownMenu: ({ children }: any) => <div>{children}</div>,
  DropdownMenuTrigger: ({ render, children }: any) => <button {...render.props}>{children}</button>,
  DropdownMenuContent: ({ children }: any) => <div>{children}</div>,
  DropdownMenuItem: ({ children, ...props }: any) => <button {...props}>{children}</button>,
  Skeleton: (props: any) => <div {...props} />,
  Button: ({ children, variant, size, ...props }: any) => <button {...props}>{children}</button>,
  Input: (props: any) => <input {...props} />,
  Label: ({ htmlFor, children, ...props }: any) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  Textarea: (props: any) => <textarea {...props} />,
  NativeSelect: (props: any) => <select {...props} />,
  NativeSelectOption: (props: any) => <option {...props} />,
}));
vi.mock("./CallDoctorDirectory", () => ({
  CallDoctorDirectory: ({ open }: any) => (open ? <div role="dialog">Doctor directory</div> : null),
}));

const row: CallRequestRow = {
  id: "request-one",
  doctorId: "doctor",
  doctorCode: "D01",
  doctorName: "Doctor One",
  date: "2026-11-04",
  type: "no_call",
  shift: "Night",
  text: "",
  createdAt: "",
  updatedAt: "",
};
const doctorView: CallRequestDoctorView = {
  doctor: { id: "doctor", code: "D01", name: "Doctor One" },
  requests: [row],
  limit: 5,
};
const managerView: CallRequestManagerView = {
  spaceId: "clinic",
  spaceName: "Clinic",
  emailDelivery: true,
  doctors: [
    { id: "doctor", code: "D01", name: "Doctor One", email: "one@example.test", active: true },
  ],
  requests: [row],
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});
async function renderDoctor(strict = false) {
  const page = (
    <MemoryRouter initialEntries={["/call-requests/clinic"]}>
      <Routes>
        <Route path="/call-requests/:spaceId" element={<DoctorCallRequestsPage />} />
      </Routes>
    </MemoryRouter>
  );
  await act(async () => root.render(strict ? <StrictMode>{page}</StrictMode> : page));
}
async function renderManager() {
  await act(async () =>
    root.render(
      <MemoryRouter>
        <ManagerCallRequestsPage />
      </MemoryRouter>,
    ),
  );
}
function button(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) =>
    b.textContent?.includes(name),
  )!;
}
async function change(selector: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(selector)!;
  await act(async () => {
    const prototype =
      input.tagName === "SELECT"
        ? HTMLSelectElement.prototype
        : input.tagName === "TEXTAREA"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(
      new Event(input.tagName === "SELECT" ? "change" : "input", { bubbles: true }),
    );
  });
}
async function submit(selector: string) {
  await act(async () =>
    host
      .querySelector(selector)!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}

it("asks doctors to contact their administrator when email sign-in is unavailable", async () => {
  vi.mocked(callRequestApi).mockImplementation(async (route) => {
    if (route.includes("?month=")) throw new CallRequestApiError("Verify your email", 401);
    throw new CallRequestApiError("Email delivery is not configured", 503);
  });
  await renderDoctor();
  await change("#doctor-email", "one@example.test");
  await submit("form");
  expect(host.querySelector('[role="alert"]')!.textContent).toBe(
    "Doctor sign-in is unavailable. Contact your administrator.",
  );
  expect(host.querySelector("#doctor-code")).toBeNull();
});

it("an unregistered Rakazo visitor signs in using only email and code, including StrictMode replay", async () => {
  let verified = false;
  vi.mocked(callRequestApi).mockImplementation(async (route, options) => {
    if (route.includes("?month=")) {
      if (!verified) throw new CallRequestApiError("Sign in required", 401);
      return doctorView as any;
    }
    expect(options?.signal?.aborted).toBe(false);
    if (route.endsWith("/verify")) verified = true;
    return { ok: true } as any;
  });
  await renderDoctor(true);
  expect(host.querySelector('input[type="password"]')).toBeNull();
  await change("#doctor-email", "one@example.test");
  await submit("form");
  expect(callRequestApi).toHaveBeenCalledWith(
    "/clinic/code",
    expect.objectContaining({ body: { email: "one@example.test" } }),
  );
  await change("#doctor-code", "123456");
  await submit("form:nth-of-type(2)");
  expect(host.textContent).toContain("Doctor One");
  expect(host.querySelector("#doctor-code")).toBeNull();
});

it("five existing records block adding but still permit editing; No call sends no reason", async () => {
  const full = {
    ...doctorView,
    requests: Array.from({ length: 5 }, (_, i) => ({ ...row, id: `r${i}` })),
  };
  vi.mocked(callRequestApi).mockImplementation(async (route) =>
    route.includes("?month=") ? (full as any) : { ok: true },
  );
  await renderDoctor();
  expect(host.textContent).toContain("Monthly limit reached.");
  expect(button("Add request")).toBeUndefined();
  await act(async () =>
    host.querySelector<HTMLButtonElement>('[aria-label="Edit request for 2026-11-04"]')!.click(),
  );
  expect(host.querySelector("#call-text")).toBeNull();
  await submit('[aria-label="Edit request"]');
  expect(callRequestApi).toHaveBeenCalledWith(
    "/clinic/requests",
    expect.objectContaining({
      body: { id: "r0", date: row.date, type: "no_call", shift: "Night", text: "" },
    }),
  );
});

it("copy fetches the latest monthly rows instead of stale displayed rows", async () => {
  let reads = 0;
  vi.mocked(callRequestApi).mockImplementation(
    async () => ({ ...managerView, requests: ++reads === 1 ? [row] : [] }) as any,
  );
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await renderManager();
  await act(async () => button("Copy month table").click());
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0]![0]).not.toContain("Doctor One");
  expect(host.textContent).toContain("No requests this month.");
});

it("copy remains available for an empty displayed month and includes newly submitted requests", async () => {
  let reads = 0;
  vi.mocked(callRequestApi).mockImplementation(
    async () => ({ ...managerView, requests: ++reads === 1 ? [] : [row] }) as any,
  );
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await renderManager();
  expect(host.textContent).toContain("No requests this month.");
  expect(button("Copy month table").disabled).toBe(false);
  await act(async () => button("Copy month table").click());
  expect(writeText).toHaveBeenCalledOnce();
  expect(writeText.mock.calls[0]![0]).toContain("D01\tDoctor One\t2026-11-04\tNo call");
  expect(host.querySelector("tbody")!.textContent).toContain("Doctor One");
});

it("late response for a previous month cannot replace the current month", async () => {
  let late: ((view: CallRequestManagerView) => void) | undefined;
  vi.mocked(callRequestApi).mockImplementation(async (route) => {
    if (route.endsWith("2027-01"))
      return new Promise((resolve) => {
        late = resolve as any;
      });
    return { ...managerView, requests: [] } as any;
  });
  await renderManager();
  await change('input[type="month"]', "2027-01");
  await change('input[type="month"]', "2027-02");
  await act(async () => late?.(managerView));
  expect(host.querySelector("tbody")).toBeNull();
  expect(host.querySelector<HTMLInputElement>('input[type="month"]')!.value).toBe("2027-02");
});

it("keeps roster editing and deployment details out of the monthly review", async () => {
  vi.mocked(callRequestApi).mockResolvedValue({ ...managerView, emailDelivery: false } as any);
  await renderManager();
  expect(host.querySelector("details")).toBeNull();
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.textContent).not.toContain("Email delivery is not configured");
  expect(host.textContent).not.toContain("true/false");
  expect(host.querySelector("tbody")!.textContent).not.toContain("D01");
  expect(host.querySelectorAll("thead th")).toHaveLength(4);
  await act(async () => button("Manage doctors").click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});

it("shows an unavailable sign-in message only when trying to share the doctor link", async () => {
  vi.mocked(callRequestApi).mockResolvedValue({ ...managerView, emailDelivery: false } as any);
  const writeText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await renderManager();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  await act(async () => button("Copy doctor link").click());
  expect(host.querySelector('[role="alert"]')!.textContent).toContain(
    "Doctor sign-in is unavailable",
  );
  expect(writeText).not.toHaveBeenCalled();
});
