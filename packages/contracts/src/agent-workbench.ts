import { z } from "zod";

export const safeText = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !/[\u0000\uD800-\uDFFF]/u.test(s), "Invalid text");
const label = safeText(200).pipe(z.string().trim().min(1));
const fieldId = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/);
const finiteNumber = z
  .number()
  .finite()
  .refine((n) => Math.abs(n) <= Number.MAX_SAFE_INTEGER);
export const QuestionField = z
  .object({
    id: fieldId,
    label,
    type: z.enum(["choice", "text", "number", "date"]),
    options: z.array(label).min(2).max(6).optional(),
    min: finiteNumber.optional(),
    max: finiteNumber.optional(),
    required: z.boolean().default(true),
  })
  .strict()
  .superRefine((f, ctx) => {
    if (
      (f.type === "choice") !== Boolean(f.options) ||
      (f.options && new Set(f.options).size !== f.options.length)
    )
      ctx.addIssue({ code: "custom", message: "Distinct choices required only for choice fields" });
    if (
      (f.type !== "number" && (f.min !== undefined || f.max !== undefined)) ||
      (f.min !== undefined && f.max !== undefined && f.min > f.max)
    )
      ctx.addIssue({ code: "custom", message: "Invalid numeric bounds" });
  });
export const QuestionForm = z
  .object({
    schema: z.literal("rakazo/question-form/v1"),
    fields: z.array(QuestionField).min(1).max(3),
  })
  .strict()
  .refine(
    (f) => new Set(f.fields.map((x) => x.id)).size === f.fields.length,
    "Distinct field ids required",
  );
export type QuestionForm = z.infer<typeof QuestionForm>;
export function validateQuestionAnswer(form: QuestionForm, raw: string) {
  const value = z
    .object({
      schema: z.literal("rakazo/question-answer/v1"),
      values: z.record(z.string(), z.union([safeText(2000), finiteNumber])),
    })
    .strict()
    .parse(JSON.parse(raw));
  if (Object.keys(value.values).some((id) => !form.fields.some((f) => f.id === id)))
    throw new Error("Unknown question field");
  for (const f of form.fields) {
    const v = value.values[f.id];
    if (v === undefined || v === "") {
      if (f.required) throw new Error("Required answer missing");
      continue;
    }
    if (f.type === "number") {
      if (
        typeof v !== "number" ||
        (f.min !== undefined && v < f.min) ||
        (f.max !== undefined && v > f.max)
      )
        throw new Error("Invalid number");
    } else if (typeof v !== "string" || !v.trim()) throw new Error("Text answer required");
    else if (f.type === "choice" && !f.options!.includes(v)) throw new Error("Unknown choice");
    else if (
      f.type === "date" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(v) ||
        !Number.isFinite(Date.parse(v)) ||
        new Date(v).toISOString().slice(0, 10) !== v)
    )
      throw new Error("Invalid date");
  }
  return JSON.stringify(value);
}

export const WorkspacePath = safeText(500).refine(
  (s) =>
    s.startsWith("workspace/") &&
    !/[\\\x00-\x1f]/.test(s) &&
    s.split("/").every((p) => p && p !== "." && p !== ".." && !p.startsWith(".")),
  "Exact workspace-relative path required",
);
export const HelperInput = z
  .object({
    name: label,
    task: safeText(16000).pipe(z.string().min(1)),
    instructions: safeText(2000).optional(),
    model_provider: z.string().optional(),
    model_id: z.string().optional(),
  })
  .strict();
export const GoalInput = z
  .object({
    objective: safeText(4000).pipe(z.string().trim().min(1)),
    status: z.enum(["active", "paused", "complete"]).default("active"),
  })
  .strict();
export const WorkbenchToolInput = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("current") }).strict(),
  z.object({ operation: z.literal("propose_goal"), objective: GoalInput.shape.objective }).strict(),
  z
    .object({
      operation: z.literal("propose_change"),
      path: WorkspacePath,
      proposedText: safeText(64000),
    })
    .strict(),
  z.object({ operation: z.literal("create_scenario"), title: label }).strict(),
  z
    .object({
      operation: z.literal("scenario_message"),
      id: z.uuid(),
      message: safeText(8000).pipe(z.string().min(1)),
    })
    .strict(),
]);
export const WorkbenchBrowserInput = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("goal"),
      botId: z.string().min(1).max(160),
      revision: z.number().int().nonnegative(),
      goal: GoalInput,
    })
    .strict(),
  z
    .object({
      operation: z.literal("scenario"),
      botId: z.string().min(1).max(160),
      title: label,
      nonce: z.uuid(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("scenario_message"),
      botId: z.string().min(1).max(160),
      id: z.uuid(),
      message: safeText(8000).pipe(z.string().min(1)),
      nonce: z.uuid(),
    })
    .strict(),
  z
    .object({
      operation: z.literal("save_draft"),
      botId: z.string().min(1).max(160),
      id: z.uuid(),
      digest: z.string().regex(/^[a-f0-9]{64}$/),
      password: safeText(1024).pipe(z.string().min(1)),
    })
    .strict(),
  z.object({ operation: z.literal("refresh_skills"), botId: z.string().min(1).max(160) }).strict(),
  z
    .object({
      operation: z.literal("select_skill"),
      botId: z.string().min(1).max(160),
      id: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .nullable(),
    })
    .strict(),
]);
export const workbenchTools = [
  {
    name: "workspace_control",
    description:
      "Private chat workbench. Inspect persistent goals, scenario-analysis branches, installed skills, helper and hook receipts. Propose a source-bound text change for human review; saving creates a separate draft, never overwrites originals. Scenario analysis and helpers have no tools or solver. Goals and proposals grant no policy approval or compute. Return the reviewUrl to the user. Never claim a draft, branch or goal is an approved policy or completed solve.",
    inputSchema: z.toJSONSchema(WorkbenchToolInput),
  },
];
export const formTools = [
  {
    name: "ask_form",
    description:
      "Ask one to three related typed questions: choices, short text, bounded number or date. Persist the form and wait quietly for the authenticated owner's answers. No default, timeout, reminder or automatic consent. Never ask for passwords/keys or treat these answers as protected policy approval or extra solve allowance.",
    inputSchema: z.toJSONSchema(
      z.object({ question: safeText(2000).pipe(z.string().min(1)), form: QuestionForm }).strict(),
    ),
  },
];
