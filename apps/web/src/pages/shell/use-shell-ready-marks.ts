import { useLayoutEffect } from "react";
import { markAfterPaint, markOnce } from "../../lib/platform/performance";
import { markShellReady } from "./space-switch";

export function useShellReadiness(input: {
  botsLoaded: boolean;
  botsEmpty: boolean;
  active: { id: string } | undefined;
  groupRoute: boolean;
  activeGroup: boolean;
  group: boolean;
  threadLoaded: boolean;
  snapshotBotId: string | undefined;
  hasContent: boolean;
}) {
  const { botsLoaded, botsEmpty, active, activeGroup, group, threadLoaded } = input;
  // An empty roster on its way to onboarding or another group should not flash a new-bot prompt.
  const showNewBotPrompt =
    botsLoaded && botsEmpty && !activeGroup && !input.groupRoute && input.hasContent;
  const shellReady =
    botsLoaded &&
    (group ? activeGroup && threadLoaded : botsEmpty || Boolean(active && threadLoaded));
  useShellReadyMarks({ botsLoaded, active, snapshotBotId: input.snapshotBotId, ready: shellReady });
  return { showNewBotPrompt, shellReady };
}

/** Marks the shell's first bots, thread and ready paint, and ends a space switch once it is ready. */
export function useShellReadyMarks({
  botsLoaded,
  active,
  snapshotBotId,
  ready,
}: {
  botsLoaded: boolean;
  active: { id: string } | undefined;
  /** The bot whose thread was read last. */
  snapshotBotId: string | undefined;
  ready: boolean;
}) {
  useLayoutEffect(() => {
    if (botsLoaded) {
      markOnce("rk:renderer:bots-committed");
      markAfterPaint("rk:renderer:bots-painted");
    }
    if (active && snapshotBotId === active.id) {
      markOnce("rk:renderer:thread-committed");
      markAfterPaint("rk:renderer:thread-painted");
    }
    if (ready) {
      markShellReady();
      markOnce("rk:renderer:shell-ready");
      markAfterPaint("rk:renderer:shell-painted");
    }
  }, [active, botsLoaded, ready, snapshotBotId]);
}
