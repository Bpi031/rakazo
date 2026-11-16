import { z } from "zod";

export const callRequestId = z.string().regex(/^[A-Za-z0-9_-]{1,160}$/);
export const callRequestMonth = z.string().regex(/^(19|20|21)\d{2}-(0[1-9]|1[0-2])$/);
export const callRequestDate = z
  .string()
  .regex(/^(19|20|21)\d{2}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Choose a valid date");
const singleLine = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) =>
      Array.from(s).every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127),
    );
export const callRequestType = z.enum(["no_call", "prefer_call", "others"]);
export type CallRequestType = z.infer<typeof callRequestType>;
export const callRequestInput = z
  .object({
    id: callRequestId.optional(),
    date: callRequestDate,
    type: callRequestType,
    shift: singleLine(80),
    text: singleLine(2000),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.type === "others" && !value.text)
      ctx.addIssue({ code: "custom", path: ["text"], message: "Enter your request" });
    if (value.type !== "others" && value.text)
      ctx.addIssue({ code: "custom", path: ["text"], message: "Text is only used for Others" });
  });
export type CallRequestInput = z.infer<typeof callRequestInput>;
export const callDoctorInput = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9_.-]{1,80}$/),
    name: singleLine(120).pipe(z.string().min(1)),
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
    active: z.boolean(),
  })
  .strict();
export const callDoctorBatchInput = z
  .object({ doctors: z.array(callDoctorInput).min(1).max(1000) })
  .strict();
export const callRequestEmailInput = z
  .object({
    email: z
      .email()
      .max(254)
      .transform((value) => value.toLowerCase()),
  })
  .strict();
export const callRequestVerifyInput = callRequestEmailInput
  .extend({ code: z.string().regex(/^\d{6}$/) })
  .strict();

export interface CallDoctor {
  id: string;
  code: string;
  name: string;
  email: string;
  active: boolean;
}
export interface CallRequestRow {
  id: string;
  doctorId: string;
  doctorCode: string;
  doctorName: string;
  date: string;
  type: CallRequestType;
  shift: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}
export interface CallRequestManagerView {
  spaceId: string;
  spaceName: string;
  emailDelivery: boolean;
  doctors: CallDoctor[];
  requests: CallRequestRow[];
}
export interface CallRequestDoctorView {
  doctor: Pick<CallDoctor, "id" | "code" | "name">;
  requests: CallRequestRow[];
  limit: 5;
}
