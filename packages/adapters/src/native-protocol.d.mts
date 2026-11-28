import type { NativeUsageCounters } from "@rakazo/adapter-kit";

export const nativeReadNames: Set<string>;
export function digestNative(v: unknown): string;
export function boundedCapabilities(
  models: unknown,
  skills: unknown,
  requirements: unknown,
): {
  protocol: "0.144.5";
  models: { id: string; efforts: string[]; inputModalities: ("text" | "image")[] }[];
  skills: { name: string; description: string; enabled: boolean }[];
  requirementsPresent: boolean;
  qualifiedByOperator: false;
};
export function safeNativeDiff(
  value: unknown,
  roots?: readonly string[],
):
  | { sha256: string; redacted: true; diff: null }
  | { sha256: string; redacted: false; diff: string; policyApprovalGranted: false };
export function usageDelta(
  current: NativeUsageCounters | null | undefined,
  previous: NativeUsageCounters | null | undefined,
): NativeUsageCounters | null | undefined;
export const completionOutputSchema: Record<string, unknown>;
