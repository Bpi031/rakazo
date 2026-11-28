import type { Bot } from "@rakazo/contracts";
import { Button } from "@rakazo/ui-web";
import { Wrench } from "lucide-react";
import { useState } from "react";
import type { SetURLSearchParams } from "react-router-dom";
import { AgentWorkbenchPanel } from "../../components/AgentWorkbenchPanel";
import { CheckpointGenerationMonitor } from "../../components/CheckpointsPanel";
import { ManagedModelPicker } from "../../components/ManagedModelPicker";
import { NativeAgentPanel } from "../../components/NativeAgentPanel";
import { PolicyReviewCard } from "../../components/PolicyReviewCard";
import { TeamWorkflowsPanel } from "../../components/TeamWorkflowsPanel";
import { useCheckpointI18n } from "../../lib/checkpoint-i18n";
import type { RightPanel } from "./use-right-panel";

export function useManagedChat({
  managedBot,
  developerMode,
  defaultModel,
  panel,
  setPanel,
  searchParams,
  setSearchParams,
  onBotChange,
}: {
  managedBot: Bot | undefined;
  developerMode?: boolean;
  defaultModel?: string | null;
  panel: RightPanel["panel"];
  setPanel: RightPanel["setPanel"];
  searchParams: URLSearchParams;
  setSearchParams: SetURLSearchParams;
  onBotChange: (bot: Bot) => void;
}) {
  const { copy: checkpointText } = useCheckpointI18n();
  const [checkpointBlockedBot, setCheckpointBlockedBot] = useState<string | null>(null);
  const [checkpointBusyBots, setCheckpointBusyBots] = useState<ReadonlySet<string>>(new Set());
  const checkpointBlocked = !!managedBot && checkpointBlockedBot === managedBot.id;
  const checkpointBusy = !!managedBot && checkpointBusyBots.has(managedBot.id);
  const developer = managedBot && developerMode === true;
  const workbench = developer ? searchParams.get("workbench") : null;
  const workflows = managedBot ? searchParams.get("workflows") : null;
  const priorityReview = managedBot ? searchParams.get("priorityReview") : null;
  function updateChatPanels(changes: Record<string, string | null>) {
    setSearchParams((previous) => {
      const params = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) params.delete(key);
        else params.set(key, value);
      }
      return params;
    });
  }
  const actions = managedBot ? (
    <>
      {developerMode === true ? (
        <NativeAgentPanel key={managedBot.id} botId={managedBot.id} compact />
      ) : null}
      {developer ? (
        <Button
          type="button"
          variant="floating"
          size="icon"
          aria-label="Agent workbench"
          title="Agent workbench"
          onClick={() => updateChatPanels({ workbench: "goals" })}
        >
          <Wrench className="size-4" />
        </Button>
      ) : null}
      <ManagedModelPicker
        key={managedBot.id}
        bot={managedBot}
        defaultModel={defaultModel}
        onChange={onBotChange}
      />
      <Button
        variant="floating"
        size="sm"
        aria-pressed={panel === "checkpoints"}
        onClick={() => setPanel(panel === "checkpoints" ? null : "checkpoints")}
      >
        {checkpointText.title}
      </Button>
    </>
  ) : null;
  const blockedBanner = checkpointBlocked ? (
    <div
      role="alert"
      className="relative z-30 flex min-w-0 items-center justify-between gap-2 bg-background px-4 py-2 text-body text-destructive"
    >
      <span>{checkpointText.messagingBlocked}</span>
      <Button variant="outline" size="sm" onClick={() => setPanel("checkpoints")}>
        {checkpointText.view}
      </Button>
    </div>
  ) : null;
  const inlinePanels =
    managedBot && (workbench !== null || workflows !== null || priorityReview !== null) ? (
      <div className="rk-scroll max-h-[45%] shrink-0 overflow-auto px-4 pt-14">
        {workbench !== null ? (
          <AgentWorkbenchPanel
            key={`${managedBot.id}:${workbench}:${searchParams.get("review")}`}
            botId={managedBot.id}
            initialTab={workbench}
            initialReview={searchParams.get("review") ?? undefined}
            onClose={() => updateChatPanels({ workbench: null, review: null })}
          />
        ) : null}
        {workflows !== null ? (
          <TeamWorkflowsPanel
            key={`${managedBot.id}:${workflows}`}
            botId={managedBot.id}
            selectedId={workflows}
            onClose={() => updateChatPanels({ workflows: null })}
          />
        ) : null}
        {priorityReview && /^[a-f0-9-]{36}$/.test(priorityReview) ? (
          <PolicyReviewCard
            key={`${managedBot.id}:${priorityReview}`}
            botId={managedBot.id}
            reviewId={priorityReview}
          />
        ) : null}
      </div>
    ) : null;
  const monitor = managedBot ? (
    <CheckpointGenerationMonitor
      key={managedBot.id}
      botId={managedBot.id}
      onBlockedChange={(blocked) =>
        setCheckpointBlockedBot((current) =>
          blocked ? managedBot.id : current === managedBot.id ? null : current,
        )
      }
    />
  ) : null;
  const controls = managedBot
    ? {
        busy: checkpointBusy,
        onBusyChange: (busy: boolean) =>
          setCheckpointBusyBots((previous) => {
            if (previous.has(managedBot.id) === busy) return previous;
            const next = new Set(previous);
            if (busy) next.add(managedBot.id);
            else next.delete(managedBot.id);
            return next;
          }),
      }
    : undefined;
  return {
    actions,
    blockedBanner,
    inlinePanels,
    monitor,
    controls,
    workspaceBlocked: checkpointBlocked || checkpointBusy,
  };
}
