import { i18n } from "@lingui/core";
import { useSyncExternalStore } from "react";

type Descriptor = { id: string; message: string; values?: Record<string, string> };
type Translation = (descriptor: Descriptor) => string;
const interpolate = (message: string, values?: Record<string, string>) =>
  values
    ? message.replace(/\{(\w+)\}/g, (placeholder, key: string) => values[key] ?? placeholder)
    : message;

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
    tree: i18n._({ id: "checkpoint.tree", message: "Checkpoint history" }),
    details: i18n._({ id: "checkpoint.details", message: "Checkpoint details" }),
    linkedCheckpoint: i18n._({ id: "checkpoint.linkedCheckpoint", message: "Previous checkpoint" }),
    actions: i18n._({ id: "checkpoint.actions", message: "Checkpoint actions" }),
    rename: i18n._({ id: "checkpoint.rename", message: "Rename checkpoint" }),
    renameDescription: i18n._({
      id: "checkpoint.renameDescription",
      message: "Only the checkpoint name will change.",
    }),
    renameBranch: i18n._({ id: "checkpoint.renameBranch", message: "Rename branch" }),
    branchNameField: i18n._({ id: "checkpoint.branchNameField", message: "Branch name" }),
    renameBranchDescription: i18n._({
      id: "checkpoint.renameBranchDescription",
      message: "Only the branch name will change.",
    }),
    saveName: i18n._({ id: "checkpoint.saveName", message: "Save name" }),
    navigateParent: i18n._({
      id: "checkpoint.navigateParent",
      message: "Go to previous checkpoint",
    }),
    focusBranch: i18n._({ id: "checkpoint.focusBranch", message: "Focus branch" }),
    copyId: i18n._({ id: "checkpoint.copyId", message: "Copy checkpoint ID" }),
    copiedId: i18n._({ id: "checkpoint.copiedId", message: "Checkpoint ID copied." }),
    closeDetails: i18n._({ id: "checkpoint.closeDetails", message: "Close checkpoint details" }),
    inspectNode: i18n._({ id: "checkpoint.inspectNode", message: "Inspect checkpoint" }),
    allBranches: i18n._({ id: "checkpoint.allBranches", message: "All branches" }),
    branchFilter: i18n._({ id: "checkpoint.branchFilter", message: "Filter by branch" }),
    originalBranch: i18n._({ id: "checkpoint.originalBranch", message: "Original history" }),
    restoredBranch: i18n._({ id: "checkpoint.restoredBranch", message: "Restored branch" }),
    branchFrom: (checkpoint: string) =>
      i18n._({ id: "checkpoint.branchFrom", message: "From {checkpoint}", values: { checkpoint } }),
    branchRestoredAt: (date: string) =>
      i18n._({ id: "checkpoint.branchRestoredAt", message: "Restored {date}", values: { date } }),
    currentBranch: i18n._({ id: "checkpoint.currentBranch", message: "current" }),
    showTurns: i18n._({ id: "checkpoint.showTurns", message: "Show old chat checkpoints" }),
    emptyFiltered: i18n._({
      id: "checkpoint.emptyFiltered",
      message: "No checkpoints match these filters.",
    }),
    branchTip: i18n._({ id: "checkpoint.branchTip", message: "Branch tip" }),
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

const english = messages({ _: ({ message, values }) => interpolate(message, values) });
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
    _: ({ id, message, values }) => {
      const translation = i18n.messages[id];
      // Checkpoint labels are static; missing or raw entries need no ICU interpolation.
      if (!translation) return interpolate(message, values);
      return typeof translation === "string"
        ? interpolate(translation, values)
        : i18n._(id, values);
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
