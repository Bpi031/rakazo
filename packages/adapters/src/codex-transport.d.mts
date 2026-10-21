import type { AdapterContext, ComputerRef, RuntimeSession, RuntimeSessionRequest } from "@rakazo/adapter-kit";
export function openComputerRuntime(base: string, token: string, computer: ComputerRef,
  request: RuntimeSessionRequest, context: AdapterContext): Promise<RuntimeSession>;
