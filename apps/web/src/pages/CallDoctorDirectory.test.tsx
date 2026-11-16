// @vitest-environment jsdom
import type { CallDoctor } from "@rakazo/contracts";
import { act, cloneElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CallDoctorDirectory } from "./CallDoctorDirectory";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: any) => children,
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((s, part, i) => s + part + (values[i] ?? ""), ""),
  }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({ children, variant, size, render, nativeButton, ...props }: any) =>
    render ? cloneElement(render, props, children) : <button {...props}>{children}</button>,
  Dialog: ({ open, children }: any) => (open ? <div role="dialog">{children}</div> : null),
  DialogContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
  DialogTitle: ({ children }: any) => <h2>{children}</h2>,
  Input: (props: any) => <input {...props} />,
  Label: ({ htmlFor, children, ...props }: any) => (
    <label htmlFor={htmlFor} {...props}>
      {children}
    </label>
  ),
  Switch: ({ checked, onCheckedChange, ...props }: any) => (
    <input
      {...props}
      type="checkbox"
      role="switch"
      aria-checked={checked}
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

const doctor: CallDoctor = {
  id: "doctor-1",
  code: "D01",
  name: "Doctor One",
  email: "one@example.test",
  active: true,
};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
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

async function render(onSave = vi.fn().mockResolvedValue(undefined), doctors = [doctor]) {
  await act(async () =>
    root.render(
      <CallDoctorDirectory open onOpenChange={() => {}} doctors={doctors} onSave={onSave} />,
    ),
  );
  return onSave;
}
function button(name: string) {
  return [...host.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === name,
  )!;
}
async function click(element: HTMLElement) {
  await act(async () => element.click());
}
async function change(suffix: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[id$="-${suffix}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() {
  await act(async () =>
    host
      .querySelector("form")!
      .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })),
  );
}
async function upload(text: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", {
    configurable: true,
    value: [{ size: text.length, text: async () => text }],
  });
  await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
}

it("lists contacts without a raw data editor and keeps Staff ID immutable when editing", async () => {
  const save = await render();
  expect(host.querySelector("textarea")).toBeNull();
  expect(host.textContent).not.toContain("D01");
  await click(host.querySelector<HTMLButtonElement>('[aria-label="Edit Doctor One"]')!);
  expect(host.querySelector<HTMLInputElement>('input[id$="-code"]')!.readOnly).toBe(true);
  await change("code", "other-doctor");
  await change("name", "Updated Doctor");
  await click(host.querySelector<HTMLElement>('[role="switch"]')!);
  await submit();
  expect(save).toHaveBeenCalledWith([
    { code: "D01", name: "Updated Doctor", email: doctor.email, active: false },
  ]);
});

it("retains the entered form when the backend rejects a save", async () => {
  const save = vi.fn().mockRejectedValue(new Error("Email is already assigned to another doctor"));
  await render(save);
  await click(button("Add doctor"));
  await change("name", "Doctor Two");
  await change("email", "two@example.test");
  await change("code", "D02");
  await submit();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("already assigned");
  expect(host.querySelector<HTMLInputElement>('input[id$="-name"]')!.value).toBe("Doctor Two");
  expect(host.querySelector<HTMLInputElement>('input[id$="-code"]')!.value).toBe("D02");
});

it("requires an explicit preview confirmation before importing and preserves disabled access", async () => {
  const save = await render(vi.fn().mockResolvedValue(undefined), [{ ...doctor, active: false }]);
  await upload(
    "Staff ID,Name,Email\r\nD01,Updated Doctor,updated@example.test\r\nD02,Doctor Two,two@example.test",
  );
  expect(save).not.toHaveBeenCalled();
  expect(host.querySelector("table")!.textContent).toContain("Update");
  await click(button("Import doctors"));
  expect(save).toHaveBeenCalledWith([
    { code: "D01", name: "Updated Doctor", email: "updated@example.test", active: false },
    { code: "D02", name: "Doctor Two", email: "two@example.test", active: true },
  ]);
});

it("rejects an imported email assigned to a different doctor without saving", async () => {
  const save = await render();
  await upload("Code,Name,Email\nD02,Another Doctor,one@example.test");
  expect(host.querySelector('[role="alert"]')!.textContent).toContain("unique");
  expect(host.querySelector("table")).toBeNull();
  expect(save).not.toHaveBeenCalled();
});
