import { useEffect, useRef, useState } from "react";
import { useEventListener } from "../lib/use-event-listener";
import { Check, ChevronDown, Cpu, Search, X } from "lucide-react";
import type { Bot, ModelCatalogEntry, ThinkingLevel } from "@rakazo/contracts";
import { rpc } from "../lib/rpc";
import { useSave } from "../lib/query/query";
import { thinkingLevelLabel as sharedThinkingLevelLabel } from "@rakazo/i18n/thinking-level";
const thinkingLevelLabel = (level: ThinkingLevel) =>
  level === "ultra" ? "Ultra" : sharedThinkingLevelLabel(level);
import "../pages/workspace-motion.css";

export function ManagedModelPicker({
  bot,
  defaultModel,
  onChange,
}: {
  bot: Bot;
  defaultModel?: string | null;
  onChange: (bot: Bot) => void;
}) {
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const save = useSave<{ botId: string; modelId: string | null; effort: ThinkingLevel | null; close: boolean }, Bot>({
    save: (input, client) => client.bots.update({
      botId: input.botId,
      modelProvider: input.modelId ? "codex-foundry" : null,
      modelId: input.modelId,
      thinkingLevel: input.effort,
    }),
    onSaved: (updated, input) => {
      if (updated.id !== bot.id) return;
      onChange(updated);
      if (input.close) setOpen(false);
    },
  });
  const busy = save.pending;
  const error = save.error ? "Model or effort choice was not saved. No fallback was used." : catalogError;
  useEffect(() => {
    let live = true;
    void rpc.models
      .list()
      .then((rows) => {
        if (live) setModels(rows);
      })
      .catch(() => {
        if (live) setCatalogError("Models unavailable");
      });
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    setOpen(false);
    setQuery("");
  }, [bot.id]);
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
  }, [open]);
  useEventListener(open && typeof document !== "undefined" ? document : null, "pointerdown", (event) => {
    if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
  });
  const active = models.find((model) => model.id === (bot.modelId ?? defaultModel));
  const levels = active?.thinkingLevels ?? [];
  const effort = bot.thinkingLevel ?? active?.defaultThinkingLevel;
  function choose(
    id: string | null,
    thinkingLevel: ThinkingLevel | null = null,
    close = true,
  ) {
    if (busy || (id && !models.some((m) => m.id === id))) return;
    const model = models.find((m) => m.id === (id ?? defaultModel));
    if (thinkingLevel && !model?.thinkingLevels?.includes(thinkingLevel)) return;
    save.run({ botId: bot.id, modelId: id, effort: thinkingLevel, close });
  }
  return (
    <div
      className="app-no-drag relative min-w-0"
      ref={root}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          setOpen(false);
          root.current?.querySelector<HTMLButtonElement>("button")?.focus();
        }
      }}
    >
      <button
        type="button"
        aria-label="Choose model"
        title="Choose model for the next turn"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((v) => !v)}
        className="flex min-w-0 max-w-72 items-center gap-2 rounded-md px-2 py-1.5 text-body hover:bg-accent"
      >
        <Cpu size={17} className="shrink-0" />
        <span className="min-w-0 max-w-24 truncate sm:max-w-44">
          {active?.label ?? (bot.modelId ? "Unavailable model" : "Default model")}
        </span>
        {levels.length > 0 && effort && (
          <span className="shrink-0 text-label text-muted-foreground">
            {levels.includes(effort) ? thinkingLevelLabel(effort) : "Unavailable effort"}
          </span>
        )}
        <ChevronDown size={14} className="shrink-0" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-label="Approved models"
          className="workspace-panel-enter absolute right-0 top-full z-50 mt-2 w-[min(350px,calc(100vw-7rem))] rounded-lg border border-border bg-popover p-3 text-popover-foreground shadow-xl"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h2 className="text-body font-semibold">Models</h2>
            <button
              title="Close models"
              aria-label="Close models"
              className="p-1"
              onClick={() => setOpen(false)}
            >
              <X size={16} />
            </button>
          </div>
          <label className="mb-3 flex items-center gap-2 rounded-md border border-border px-2">
            <Search size={16} />
            <input
              ref={search}
              className="min-w-0 flex-1 bg-transparent py-2 text-body outline-none"
              aria-label="Search approved models"
              placeholder="Search models"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
          {error && (
            <p role="alert" className="mb-2 text-label text-destructive">
              {error}
            </p>
          )}
          <div className="max-h-64 overflow-auto" role="group" aria-label="Model choices">
            {!query && (
              <button
                className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-body hover:bg-accent"
                disabled={busy}
                aria-pressed={!bot.modelId}
                onClick={() => void choose(null)}
              >
                <span className="grid size-5 place-items-center">
                  {!bot.modelId && <Check size={16} />}
                </span>
                Space default
              </button>
            )}
            {models
              .filter((model) => model.label.toLowerCase().includes(query.toLowerCase()))
              .map((model) => (
                <button
                  key={model.id}
                  disabled={busy}
                  aria-pressed={bot.modelId === model.id}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-body hover:bg-accent disabled:opacity-50"
                  onClick={() => void choose(model.id)}
                >
                  <span className="grid size-5 shrink-0 place-items-center">
                    {bot.modelId === model.id && <Check size={16} />}
                  </span>
                  <span className="break-words">{model.label}</span>
                </button>
              ))}
            {!models.length && !error && (
              <p role="status" className="p-2 text-label">
                Loading approved models…
              </p>
            )}
          </div>
          {levels.length > 0 && (
            <fieldset className="mt-3 min-w-0 border-t border-border pt-3">
              <legend className="px-1 text-label text-muted-foreground">Reasoning effort</legend>
              <div
                role="radiogroup"
                aria-label="Reasoning effort"
                className="mt-1 flex flex-wrap gap-1 rounded-md bg-muted p-1"
                onKeyDown={(event) => {
                  if (
                    busy ||
                    !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
                  )
                    return;
                  const choices = [
                    ...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]'),
                  ];
                  const current = choices.indexOf(document.activeElement as HTMLButtonElement);
                  if (current < 0) return;
                  event.preventDefault();
                  const next =
                    choices[
                      (current +
                        (event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1) +
                        choices.length) %
                        choices.length
                    ];
                  next?.focus();
                  next?.click();
                }}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={bot.thinkingLevel == null}
                  disabled={busy}
                  onClick={() => void choose(bot.modelId, null, false)}
                  className="rounded px-2 py-1.5 text-label aria-checked:bg-background disabled:opacity-50"
                >
                  Default
                  {active?.defaultThinkingLevel
                    ? <span className="ml-2 text-muted-foreground">{thinkingLevelLabel(active.defaultThinkingLevel)}</span>
                    : null}
                </button>
                {levels.map((level) => (
                  <button
                    key={level}
                    type="button"
                    role="radio"
                    aria-checked={bot.thinkingLevel === level}
                    disabled={busy}
                    onClick={() => void choose(bot.modelId, level, false)}
                    title={`${thinkingLevelLabel(level)} reasoning for the next turn`}
                    className="rounded px-2 py-1.5 text-label aria-checked:bg-background disabled:opacity-50"
                  >
                    {thinkingLevelLabel(level)}
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <p className="mt-3 border-t border-border pt-3 text-label text-muted-foreground">
            Next turn <span className="ml-2">Same workspace and history</span>
          </p>
        </div>
      )}
    </div>
  );
}
