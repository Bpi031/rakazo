import { validateQuestionAnswer, type QuestionForm } from '@rakazo/contracts';

export function answeredFields(form: QuestionForm, answer: string) {
  try {
    const { values } = JSON.parse(validateQuestionAnswer(form, answer));
    return form.fields.filter(field => Object.hasOwn(values, field.id)).map(field => ({ id: field.id, label: field.label, value: String(values[field.id]) }));
  } catch { return null; }
}
export function AnsweredForm({ question, form, answer }: { question: string; form: QuestionForm; answer: string }) {
  const fields = answeredFields(form, answer);
  return <section aria-label="Answered questions" className="w-full min-w-0 max-w-3xl space-y-3 rounded-lg border border-border p-4">
    <h3 className="break-words text-sm font-semibold">{question}</h3>
    {fields ? <dl className="space-y-3 text-sm">{fields.map(field => <div key={field.id} className="min-w-0">
      <dt className="break-words text-muted-foreground">{field.label}</dt><dd className="whitespace-pre-wrap break-words">{field.value}</dd>
    </div>)}</dl> : <p role="status">Answer recorded. Its display could not be verified; ask for clarification before acting.</p>}
  </section>;
}
