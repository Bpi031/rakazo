import { useId, useRef, useState } from "react";
import { ArrowRight, CircleHelp, X } from "lucide-react";
import { validateQuestionAnswer, type QuestionForm } from "@rakazo/contracts";

export function QuestionFormCard({
  question,
  form,
  onAnswer,
}: {
  question: string;
  form: QuestionForm;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [hidden, setHidden] = useState(false);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const formId = useId();
  let answer: string | undefined;
  try {
    answer = validateQuestionAnswer(
      form,
      JSON.stringify({
        schema: "rakazo/question-answer/v1",
        values: Object.fromEntries(
          form.fields
            .filter((f) => values[f.id] !== undefined && values[f.id] !== "")
            .map((f) => [f.id, f.type === "number" ? Number(values[f.id]) : values[f.id]]),
        ),
      }),
    );
  } catch {}
  if (hidden)
    return (
      <button
        className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm"
        onClick={() => setHidden(false)}
      >
        <CircleHelp size={16} />
        Answer questions
      </button>
    );
  return (
    <section
      aria-label="Question form"
      className="w-full min-w-0 max-w-3xl space-y-4 rounded-lg border border-border bg-card p-4"
    >
      <header className="flex items-start justify-between gap-3">
        <h3 className="min-w-0 break-words text-sm font-semibold">{question}</h3>
        <button
          title="Answer later"
          aria-label="Answer later"
          className="shrink-0 p-1"
          disabled={busy || done}
          onClick={() => setHidden(true)}
        >
          <X size={16} />
        </button>
      </header>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!answer || submitting.current || done) return;
          submitting.current = true;
          setBusy(true);
          setError("");
          try {
            await onAnswer(answer);
            setDone(true);
          } catch {
            setError("The answer was not confirmed. Please review and submit again.");
          } finally {
            submitting.current = false;
            setBusy(false);
          }
        }}
      >
        <fieldset disabled={busy || done} className="min-w-0 space-y-4">
          {form.fields.map((f) => (
            <div key={f.id} className="min-w-0 space-y-1.5">
              <label
                htmlFor={`${formId}-${f.id}`}
                className="block break-words text-sm font-medium"
              >
                {f.label}
                {f.required ? " *" : ""}
              </label>
              {f.type === "choice" ? (
                <select
                  id={`${formId}-${f.id}`}
                  required={f.required}
                  className="w-full min-w-0 rounded border border-border bg-background p-2 text-sm"
                  value={values[f.id] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                >
                  <option value="">Select...</option>
                  {f.options!.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={`${formId}-${f.id}`}
                  type={f.type === "text" ? "text" : f.type}
                  step={f.type === "number" ? "any" : undefined}
                  maxLength={2000}
                  min={f.type === "number" ? f.min : undefined}
                  max={f.type === "number" ? f.max : undefined}
                  required={f.required}
                  className="w-full min-w-0 rounded border border-border bg-background p-2 text-sm"
                  value={values[f.id] ?? ""}
                  onChange={(e) => setValues({ ...values, [f.id]: e.target.value })}
                />
              )}
            </div>
          ))}
        </fieldset>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="px-3 py-2 text-sm"
            disabled={busy || done}
            onClick={() => setHidden(true)}
          >
            Answer later
          </button>
          <button
            type="submit"
            disabled={!answer || busy || done}
            className="inline-flex items-center gap-2 rounded border border-border px-3 py-2 text-sm disabled:opacity-40"
          >
            {done ? "Answered" : busy ? "Sending..." : "Continue"}
            <ArrowRight size={16} />
          </button>
        </div>
      </form>
    </section>
  );
}
