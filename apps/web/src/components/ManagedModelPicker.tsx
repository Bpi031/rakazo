import type { Bot, ModelCatalogEntry, ThinkingLevel } from "@rakazo/contracts";
import { thinkingLevelLabel as sharedThinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import { Check, ChevronDown, Cpu, Search, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useSave } from "../lib/query/query";
import { rpc } from "../lib/rpc";
import { useEventListener } from "../lib/use-event-listener";

const thinkingLevelLabel = (level: ThinkingLevel) =>
  level === "ultra" ? "Ultra" : sharedThinkingLevelLabel(level);

import "../pages/workspace-motion.css";

export function ManagedModelPicker({
  bot,
  defaultModel,
  onChange,
}: {
  bot: Pick<Bot, "id" | "modelId" | "thinkingLevel">;
  defaultModel?: string | null;
  onChange: (bot: Bot) => void;
}) {
  const [models, setModels] = useState<ModelCatalogEntry[]>([]);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalogError, setCatalogError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const effortGroup = useId();
  const search = useRef<HTMLInputElement>(null);
  const save = useSave<
    { botId: string; modelId: string | null; effort: ThinkingLevel | null; close: boolean },
    Bot
  >({
    save: (input, client) =>
      client.bots.update({
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
  const error = save.error
    ? "Model or effort choice was not saved. No fallback was used."
    : catalogError;
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
  useEventListener(
    open && typeof document !== "undefined" ? document : null,
    "pointerdown",
    (event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    },
  );
  const active = models.find((model) => model.id === (bot.modelId ?? defaultModel));
  const levels = active?.thinkingLevels ?? [];
  const effort = bot.thinkingLevel ?? active?.defaultThinkingLevel;
  function choose(id: string | null, thinkingLevel: ThinkingLevel | null = null, close = true) {
    if (busy || (id && !models.some((m) => m.id === id))) return;
    const model = models.find((m) => m.id === (id ?? defaultModel));
    if (thinkingLevel && !model?.thinkingLevels?.includes(thinkingLevel)) return;
    save.run({ botId: bot.id, modelId: id, effort: thinkingLevel, close });
  }
  useEventListener(
    open && typeof document !== "undefined" ? document : null,
    "keydown",
    (event) => {
      if (
        event.key !== "Escape" ||
        !(event.target instanceof Node) ||
        !root.current?.contains(event.target)
      )
        return;
      setOpen(false);
      root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    },
  );
  return (
    <div className="app-no-drag relative min-w-0" ref={root}>
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
              type="button"
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
          <fieldset className="min-w-0 max-h-64 overflow-auto" aria-label="Model choices">
            {!query && (
              <button
                type="button"
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
                  type="button"
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
          </fieldset>
          {levels.length > 0 && (
            <fieldset
              aria-label="Reasoning effort"
              className="mt-3 min-w-0 border-t border-border pt-3"
            >
              <legend className="px-1 text-label text-muted-foreground">Reasoning effort</legend>
              <div className="mt-1 flex flex-wrap gap-1 rounded-md bg-muted p-1">
                <label className="rounded px-2 py-1.5 text-label has-[:checked]:bg-background has-[:focus-visible]:outline has-[:disabled]:opacity-50">
                  <input
                    type="radio"
                    name={effortGroup}
                    value=""
                    checked={!bot.thinkingLevel}
                    disabled={busy}
                    className="sr-only"
                    onChange={() => choose(bot.modelId, null, false)}
                  />
                  Default
                  {active?.defaultThinkingLevel && (
                    <span className="ml-2 text-muted-foreground">
                      {thinkingLevelLabel(active.defaultThinkingLevel)}
                    </span>
                  )}
                </label>
                {levels.map((level) => (
                  <label
                    key={level}
                    title={`${thinkingLevelLabel(level)} reasoning for the next turn`}
                    className="rounded px-2 py-1.5 text-label has-[:checked]:bg-background has-[:focus-visible]:outline has-[:disabled]:opacity-50"
                  >
                    <input
                      type="radio"
                      name={effortGroup}
                      value={level}
                      checked={bot.thinkingLevel === level}
                      disabled={busy}
                      className="sr-only"
                      onChange={() => choose(bot.modelId, level, false)}
                    />
                    {thinkingLevelLabel(level)}
                  </label>
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
