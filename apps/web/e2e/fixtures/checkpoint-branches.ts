import type { CheckpointView } from "@rakazo/contracts";

const prompts = [
  [
    "Read the December staff list and leave requests. Keep all uploaded source files unchanged.",
    "Apply the confirmed coverage, eligibility and three-day rest rules. Show me any conflicts before solving.",
    "Keep this baseline. Balance weekend duties using the confirmed priorities and prepare a draft for review.",
  ],
  [
    "Try an alternative with fewer consecutive working weekends, while keeping all hard rules unchanged.",
    "Give the avoid-call preferences higher priority than request-call preferences. Explain the trade-offs.",
    "Save this alternative so we can compare its weekend distribution with the baseline later.",
  ],
  [
    "Explore a second alternative that spreads standby duties more evenly across eligible doctors.",
    "Keep approved leave and minimum coverage protected. Show which doctors gain or lose standby duties.",
    "Save the standby-balanced option and summarize the differences for our next review.",
  ],
];

export const checkpointBranchesPreview: CheckpointView = {
  generation: 3,
  revision: "preview-three-branches",
  blocked: false,
  activeBranchId: "preview-baseline",
  currentCheckpointId: "preview-0-2",
  branches: [
    { id: "preview-baseline", parentCheckpointId: null, lastUsedAt: "2026-11-16T04:00:00Z" },
    {
      id: "preview-weekends",
      parentCheckpointId: "preview-0-0",
      lastUsedAt: "2026-11-16T02:00:00Z",
    },
    {
      id: "preview-standby",
      parentCheckpointId: "preview-0-0",
      lastUsedAt: "2026-11-16T03:00:00Z",
    },
  ],
  checkpoints: prompts.flatMap((branchPrompts, branch) =>
    branchPrompts.map((prompt, index) => ({
      id: `preview-${branch}-${index}`,
      branchId: ["preview-baseline", "preview-weekends", "preview-standby"][branch]!,
      parentCheckpointId: index ? `preview-${branch}-${index - 1}` : branch ? "preview-0-0" : null,
      kind: "manual" as const,
      label:
        index === 2 ? ["Baseline", "Weekend alternative", "Standby alternative"][branch]! : null,
      createdAt: new Date(Date.UTC(2026, 10, 16, 1 + branch, index * 12 + 1)).toISOString(),
      promptPreview: prompt,
      promptCreatedAt: new Date(Date.UTC(2026, 10, 16, 1 + branch, index * 12)).toISOString(),
    })),
  ),
};
