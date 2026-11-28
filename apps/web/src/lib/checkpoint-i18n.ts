import { i18n } from "@lingui/core";
import { useSyncExternalStore } from "react";

type Translation = (descriptor: { id: string; message: string }) => string;

function messages(i18n: { _: Translation }) {
  return {
    title: i18n._({ id: "checkpoint.title", message: "Checkpoints" }),
    set: i18n._({ id: "checkpoint.set", message: "Set a checkpoint" }),
    name: i18n._({ id: "checkpoint.name", message: "Checkpoint name" }),
    namePlaceholder: i18n._({ id: "checkpoint.namePlaceholder", message: "Name (optional)" }),
    loading: i18n._({ id: "checkpoint.loading", message: "Loading checkpoints…" }),
    loadError: i18n._({ id: "checkpoint.loadError", message: "Could not load checkpoints." }),
    operationError: i18n._({
      id: "checkpoint.operationError",
      message: "The checkpoint operation could not be completed. Please try again.",
    }),
    savedListDelayed: i18n._({
      id: "checkpoint.savedListDelayed",
      message: "Checkpoint saved. The list has not refreshed yet.",
    }),
    stale: i18n._({ id: "checkpoint.stale", message: "Workspace changed. Please try again." }),
    conflict: i18n._({
      id: "checkpoint.conflict",
      message: "The workspace is busy or unavailable. Check its status before trying again.",
    }),
    internal: i18n._({
      id: "checkpoint.internal",
      message: "The checkpoint operation failed. Check workspace status before trying again.",
    }),
    incomplete: i18n._({
      id: "checkpoint.incomplete",
      message: "This checkpoint is missing saved data. Choose another checkpoint.",
    }),
    notFound: i18n._({
      id: "checkpoint.notFound",
      message: "This checkpoint or workspace is no longer available.",
    }),
    signIn: i18n._({ id: "checkpoint.signIn", message: "Sign in to use checkpoints." }),
    restoreError: i18n._({
      id: "checkpoint.restoreError",
      message: "Restore did not complete. Please try again.",
    }),
    blocked: i18n._({
      id: "checkpoint.blocked",
      message: "Workspace recovery is incomplete. Choose a checkpoint to retry.",
    }),
    messagingBlocked: i18n._({
      id: "checkpoint.messagingBlocked",
      message: "Workspace recovery is incomplete. Messaging is paused.",
    }),
    view: i18n._({ id: "checkpoint.view", message: "View checkpoints" }),
    confirm: i18n._({ id: "checkpoint.confirm", message: "Restore this checkpoint?" }),
    description: i18n._({
      id: "checkpoint.description",
      message: "Running tasks will stop. Any changes will be saved as a pre-rollback checkpoint.",
    }),
    restore: i18n._({ id: "checkpoint.restore", message: "Restore" }),
    cancel: i18n._({ id: "checkpoint.cancel", message: "Cancel" }),
    working: i18n._({ id: "checkpoint.working", message: "Working…" }),
    empty: i18n._({ id: "checkpoint.empty", message: "No checkpoints yet." }),
    tree: i18n._({ id: "checkpoint.tree", message: "Checkpoint tree, drag to pan" }),
    restoreNode: i18n._({ id: "checkpoint.restoreNode", message: "Restore checkpoint" }),
    noPrompt: i18n._({ id: "checkpoint.noPrompt", message: "No user message at this checkpoint." }),
    kinds: {
      manual: i18n._({ id: "checkpoint.manual", message: "Manual checkpoint" }),
      auto_pre_solve: i18n._({ id: "checkpoint.preSolve", message: "Pre-solve checkpoint" }),
      auto_pre_rollback: i18n._({
        id: "checkpoint.preRollback",
        message: "Pre-rollback checkpoint",
      }),
      auto_turn_boundary: i18n._({ id: "checkpoint.turn", message: "Turn checkpoint" }),
    },
  };
}

const english = messages({ _: ({ message }) => message });
let translated: typeof english | undefined;
let revision = 0;
i18n.on("change", () => {
  revision += 1;
  translated = undefined;
});

/** Follow the active Lingui catalog. Checkpoint translations currently support zh-CN only. */
export function checkpointCopy(locale = i18n.locale) {
  if (locale !== "zh-CN" || i18n.locale !== "zh-CN") return english;
  translated ??= messages({
    _: ({ id, message }) => {
      const translation = i18n.messages[id];
      // Checkpoint labels are static; missing or raw entries need no ICU interpolation.
      return !translation ? message : typeof translation === "string" ? translation : i18n._(id);
    },
  });
  return translated;
}

export function checkpointError(message: string, locale = i18n.locale) {
  const copy = checkpointCopy(locale);
  if (Object.values(copy).some((value) => value === message)) return message;
  if (/workspace changed|superseded/i.test(message)) return copy.stale;
  if (/recovery failed|workspace.*blocked/i.test(message)) return copy.blocked;
  if (/sign in/i.test(message)) return copy.signIn;
  return copy.operationError;
}

export function checkpointHttpError(code: unknown, message: unknown) {
  const copy = checkpointCopy();
  switch (code) {
    case "CHECKPOINT_STALE":
      return copy.stale;
    case "CHECKPOINT_CONFLICT":
      return copy.conflict;
    case "CHECKPOINT_RECOVERY_BLOCKED":
      return copy.blocked;
    case "CHECKPOINT_NOT_FOUND":
      return copy.notFound;
    case "CHECKPOINT_INCOMPLETE":
      return copy.incomplete;
    case "CHECKPOINT_INTERNAL":
      return copy.internal;
    default:
      return typeof message === "string" ? checkpointError(message) : copy.operationError;
  }
}

const subscribe = (notify: () => void) => i18n.on("change", notify);
const snapshot = () => revision;
export function useCheckpointI18n() {
  useSyncExternalStore(subscribe, snapshot, snapshot);
  const locale = i18n.locale || "en";
  return { copy: checkpointCopy(locale), locale: locale === "zh-CN" ? locale : "en-GB" };
}
