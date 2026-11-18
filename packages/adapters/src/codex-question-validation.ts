import { QuestionFormInput } from "@rakazo/contracts";

/** Use the presentation contract before the native runtime closes for a question. */
export function validateCodexQuestion(event: { type: "ask"; text: string; form?: unknown }) {
  if (!event.form) return { success: true as const, data: event };
  const result = QuestionFormInput.safeParse({ question: event.text, form: event.form });
  if (!result.success) return result;
  return { success: true as const, data: { ...event, text: result.data.question, form: result.data.form } };
}
