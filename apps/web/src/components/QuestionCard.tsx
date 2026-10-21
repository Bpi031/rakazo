import { Trans, useLingui } from "@lingui/react/macro";
import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { Button, Textarea } from "@rakazo/ui-web";
import { ArrowRight, CircleHelp, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { errorText } from "../lib/user-error";

export function QuestionCard({
  question,
  actions,
  detail,
  onAnswer,
}: {
  question: string;
  actions: readonly { id: string; label: string }[];
  detail?: string;
  onAnswer: (answer: string) => Promise<void>;
}) {
  const { t } = useLingui();
  const titleId = useId();
  const radioName = useId();
  const [selected, setSelected] = useState<string | null>(null);
  const [custom, setCustom] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [pending, setPending] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const value = selected ?? custom.trim();

  async function submit() {
    if (!value || submitting.current || submitted) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    try {
      await onAnswer(value);
      setSubmitted(true);
    } catch (err) {
      setError(errorText(err, t`Could not submit this answer`));
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  if (collapsed) {
    return (
      <Button variant="outline" onClick={() => setCollapsed(false)}>
        <CircleHelp className="size-4" aria-hidden="true" />
        <Trans>Answer question</Trans>
      </Button>
    );
  }

  return (
    <section
      data-testid="choice-question-card"
      aria-labelledby={titleId}
      className="w-full min-w-0 max-w-3xl rounded-2xl border border-border bg-card px-4 py-4 sm:px-5"
    >
      <header className="mb-4 flex items-center justify-between gap-3 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <CircleHelp className="size-4" aria-hidden="true" />
          <Trans>Question</Trans>
        </span>
        <Button
          variant="ghost"
          size="icon"
          title={t`Answer later`}
          aria-label={t`Answer later`}
          disabled={pending || submitted}
          onClick={() => setCollapsed(true)}
        >
          <X className="size-4" aria-hidden="true" />
        </Button>
      </header>
      <div id={titleId} className="break-words text-[15.5px] leading-relaxed text-foreground">
        <ChatMarkdown>{question}</ChatMarkdown>
      </div>
      {detail ? (
        <pre className="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">
          {detail}
        </pre>
      ) : null}
      <form
        className="mt-4 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <fieldset disabled={pending || submitted} className="min-w-0 space-y-2">
          <legend className="sr-only"><Trans>Choose an answer</Trans></legend>
          {actions.map((action, index) => {
            const recommended = /\s*\(Recommended\)\s*$/i.test(action.label);
            const label = recommended
              ? action.label.replace(/\s*\(Recommended\)\s*$/i, "")
              : action.label;
            return (
              <label
                key={action.id}
                className={`flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 hover:bg-muted has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-ring ${selected === action.id ? "border-foreground/30 bg-muted" : "border-transparent"}`}
              >
                <input
                  type="radio"
                  name={radioName}
                  value={action.id}
                  checked={selected === action.id}
                  onChange={() => {
                    setSelected(action.id);
                    setCustom("");
                  }}
                  className="size-4 shrink-0 accent-current"
                />
                <span aria-hidden="true" className="text-sm tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 break-words text-[15px] leading-snug">
                  {label}
                  {recommended ? (
                    <span className="ml-2 inline-block rounded bg-muted px-2 py-1 text-xs text-muted-foreground">
                      <Trans>Recommended</Trans>
                    </span>
                  ) : null}
                </span>
                {selected === action.id ? <ArrowRight className="size-4 shrink-0" aria-hidden="true" /> : null}
              </label>
            );
          })}
          <Textarea
            aria-label={t`Your own response`}
            placeholder={t`Or write your own response`}
            maxLength={2000}
            rows={2}
            value={custom}
            onChange={(event) => {
              setCustom(event.target.value);
              setSelected(null);
            }}
            className="mt-3 resize-y"
          />
        </fieldset>
        {error ? <p role="alert" className="break-words text-sm text-destructive">{error}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button type="button" variant="ghost" disabled={pending || submitted} onClick={() => setCollapsed(true)}>
            <Trans>Answer later</Trans>
          </Button>
          <Button type="submit" disabled={!value || pending || submitted}>
            {pending ? <Trans>Sending...</Trans> : submitted ? <Trans>Answered</Trans> : <Trans>Continue</Trans>}
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </form>
    </section>
  );
}
