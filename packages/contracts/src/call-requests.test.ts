import { expect, it } from "vitest";
import {
  callDoctorBatchInput,
  callRequestDate,
  callRequestInput,
  callRequestMonth,
  callRequestVerifyInput,
} from "./call-requests.js";

it("accepts real calendar days and rejects overflow and ranges", () => {
  expect(callRequestDate.safeParse("2028-02-29").success).toBe(true);
  for (const date of ["2026-02-29", "2026-04-31", "2026-13-01", "2026-11-16/17"])
    expect(callRequestDate.safeParse(date).success).toBe(false);
  expect(callRequestMonth.safeParse("2026-11").success).toBe(true);
  expect(callRequestMonth.safeParse("2026-13").success).toBe(false);
});

it("requires Others text and prevents hidden reasons or injected ownership", () => {
  const request = { date: "2026-11-16", type: "no_call", shift: "", text: "" };
  expect(callRequestInput.safeParse(request).success).toBe(true);
  expect(
    callRequestInput.safeParse({ ...request, type: "prefer_call", shift: "Night" }).success,
  ).toBe(true);
  expect(callRequestInput.safeParse({ ...request, type: "others" }).success).toBe(false);
  expect(
    callRequestInput.safeParse({ ...request, type: "others", text: "Call with a senior" }).success,
  ).toBe(true);
  expect(callRequestInput.safeParse({ ...request, text: "hidden reason" }).success).toBe(false);
  expect(callRequestInput.safeParse({ ...request, doctorId: "someone-else" }).success).toBe(false);
});

it("rejects control characters that could create forged monthly table rows", () => {
  for (const text of ["first\nsecond", "x\ty", "x\u0000y"])
    expect(
      callRequestInput.safeParse({ date: "2026-11-16", type: "others", shift: "", text }).success,
    ).toBe(false);
});

it("normalizes individual emails and accepts exactly six numeric code digits", () => {
  expect(callRequestVerifyInput.parse({ email: "Doctor@Example.test", code: "001234" }).email).toBe(
    "doctor@example.test",
  );
  for (const code of ["12345", "1234567", "12a456"])
    expect(callRequestVerifyInput.safeParse({ email: "doctor@example.test", code }).success).toBe(
      false,
    );
  expect(
    callDoctorBatchInput.safeParse({
      doctors: [{ code: "D01", name: "Doctor A", email: "doctor@example.test", active: true }],
    }).success,
  ).toBe(true);
});
