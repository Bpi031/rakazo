import type { ThinkingLevel } from "@rakazo/contracts";
export type ManagedReasoning = Record<string, { levels: ThinkingLevel[]; default: ThinkingLevel }>;
export function managedReasoning(env?: NodeJS.ProcessEnv): ManagedReasoning;
export function managedEffort(id: string, requested: unknown, configuration: ManagedReasoning): ThinkingLevel | null;
