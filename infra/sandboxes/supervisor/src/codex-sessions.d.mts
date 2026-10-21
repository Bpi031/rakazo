import type { Hono } from "hono";
import type Docker from "dockerode";
export function mountCodexSessions(app: Hono, options: { docker: Docker; env?: NodeJS.ProcessEnv;
  managedContainer(id: string, botId?: string, spaceId?: string): Promise<{container: Docker.Container; info: Docker.ContainerInspectInfo}> }): Map<string, unknown>;
