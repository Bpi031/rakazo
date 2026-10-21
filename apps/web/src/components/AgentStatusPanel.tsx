import type { AgentStatusFields } from "@rakazo/contracts";
import { Check, Circle, LoaderCircle } from "lucide-react";

const activityNames = {
  command: "command",
  file_change: "file update",
  tool: "tool",
  web_search: "web search",
  compaction: "context compaction",
};
const number = (value: number | null | undefined) =>
  value == null ? "Unavailable" : value.toLocaleString("en-US");

export function AgentStatusPanel({ value, live }: { value: AgentStatusFields; live: boolean }) {
  const completed = value.plan?.filter((step) => step.status === "completed").length ?? 0;
  return (
    <details
      key={String(live)}
      open={live}
      className="w-full max-w-xl rounded-md border border-border px-3 py-2 text-sm"
      data-testid="agent-status"
    >
      <summary className="cursor-pointer select-none text-muted-foreground">
        Agent status{value.plan?.length ? ` · ${completed}/${value.plan.length} steps` : ""}
        {value.usage?.totalTokens != null ? ` · ${number(value.usage.totalTokens)} tokens` : ""}
      </summary>
      <div className="mt-2 space-y-3">
        {value.configuration && (
          <p
            className="break-words text-xs text-muted-foreground"
            aria-label="Active turn configuration"
          >
            {value.configuration.model} · {value.configuration.effort} effort · This turn
          </p>
        )}
        {value.plan?.length ? (
          <ol className="space-y-1.5" aria-label="Agent plan">
            {value.plan.map((step, i) => {
              const Icon =
                step.status === "completed"
                  ? Check
                  : step.status === "inProgress" && live
                    ? LoaderCircle
                    : Circle;
              return (
                <li key={i} className="flex items-start gap-2">
                  <Icon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <span className="min-w-0 break-words">
                    {step.step}{" "}
                    <span className="text-xs text-muted-foreground">
                      (
                      {step.status === "inProgress"
                        ? live
                          ? "in progress"
                          : "unfinished"
                        : step.status}
                      )
                    </span>
                  </span>
                </li>
              );
            })}
          </ol>
        ) : null}
        {value.explanation ? (
          <p className="break-words text-muted-foreground">{value.explanation}</p>
        ) : null}
        {value.activity ? (
          <p className="text-muted-foreground" role="status">
            Last {activityNames[value.activity.kind]}: {value.activity.status}
            {value.activity.durationMs != null
              ? ` · ${(value.activity.durationMs / 1000).toFixed(1)}s`
              : ""}
            {value.activity.filesChanged != null
              ? ` · ${number(value.activity.filesChanged)} files`
              : ""}
          </p>
        ) : null}
        {value.usage ? (
          <>
            <p className="text-xs text-muted-foreground" aria-label="Token counter scope">
              {value.usage.scope === "turn" ? "This turn" : "Session total (legacy record)"}
            </p>
            {value.usage.contextUsedTokens != null &&
            value.usage.contextWindow != null &&
            value.usage.contextWindow > 0 ? (
              <div className="space-y-1 text-xs text-muted-foreground">
                <p>
                  Last model request: {number(value.usage.contextUsedTokens)} /{" "}
                  {number(value.usage.contextWindow)} tokens
                </p>
                <progress
                  aria-label="Last request context usage"
                  max={value.usage.contextWindow}
                  value={Math.min(value.usage.contextWindow, value.usage.contextUsedTokens)}
                  className="h-1.5 w-full accent-current"
                />
              </div>
            ) : null}
            <dl
              className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3"
              aria-label="Model-reported token usage"
            >
              {[
                ["Input (includes cached)", value.usage.inputTokens],
                ["Cached input", value.usage.cachedInputTokens],
                ["Output (includes reasoning)", value.usage.outputTokens],
                ["Reasoning", value.usage.reasoningTokens],
                ["Total", value.usage.totalTokens],
                ["Context limit", value.usage.contextWindow],
              ].map(([label, count]) => (
                <div key={String(label)}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="tabular-nums">{number(count as number | null)}</dd>
                </div>
              ))}
            </dl>
          </>
        ) : null}
      </div>
    </details>
  );
}
