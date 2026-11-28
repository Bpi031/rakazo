import type { JobPublisher } from "@rakazo/adapter-kit";
import type {
  CheckpointService,
  createAgentHomeStore,
  createArtifactStore,
  startServerFoundation,
} from "@rakazo/adapters";
import type { SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import type { requestSessions } from "../auth/request-session.js";
import type { AppEnv } from "../env.js";
import { AccountAdminService, mountAccountAdmin } from "../account-admin.js";
import { mountTeamWorkflows } from "../team-workflows-http.js";
import { mountAgentWorkbench } from "../agent-workbench-http.js";
import { AgentWorkbench, workbenchEnabled, NativeControl, nativeEnabled } from "@rakazo/adapters";
import { TeamWorkflowService, TeamLeadershipService } from "@rakazo/adapters";
import {
  TeamService,
  observeTeamComputers,
  teamEnabled,
  teamMessagingEnabled,
} from "@rakazo/adapters";
import { mountTeamHttp, mountDisabledTeamHttp } from "../team-http.js";
import { mountManagedServiceGuards } from "../managed-services.js";
import { mountManagedUsage } from "../managed-usage.js";
import { mountPriorityHttp } from "../policy-priorities-http.js";
import { mountCheckpointHttp } from "../checkpoints-http.js";
import { mountWorkspaceInsights, WorkspaceInsights } from "../workspace-insights.js";
import { PriorityService } from "@rakazo/adapters";
import { PolicyWorkflow } from "@rakazo/adapters";
import { mountPolicyWorkflow } from "../policy-workflow-http.js";
import { signupPolicyFromEnv } from "@rakazo/core";
import { developerAccess } from "../developer-access.js";

export async function initializeManagedSignupPolicy(prisma: PrismaClient, env: AppEnv) {
  if (env.agentRuntime === "codex") {
    const policy = signupPolicyFromEnv(env);
    const data = {
      signupsEnabled: policy.enabled,
      signupAllowlist: policy.allowlist.join(","),
      signupPolicyInitialized: true,
    };
    await prisma.managedSignupPolicy.upsert({
      where: { id: "default" },
      create: { id: "default", ...data },
      update: {},
    });
    await prisma.managedSignupPolicy.updateMany({
      where: { id: "default", signupPolicyInitialized: false },
      data,
    });
  }
}

export function mountManagedRoutes(
  app: Hono,
  deps: {
    env: AppEnv;
    prisma: PrismaClient;
    sandbox: SandboxProvider;
    jobs: JobPublisher;
    home: ReturnType<typeof createAgentHomeStore>;
    artifacts: ReturnType<typeof createArtifactStore>;
    events: Awaited<ReturnType<typeof startServerFoundation>>["events"];
    checkpoints: CheckpointService | undefined;
    sessionActor: ReturnType<typeof requestSessions>["sessionActor"];
    verifyPassword: (request: Request, password: string) => Promise<boolean>;
    emailEnabled: boolean;
  },
) {
  const {
    env,
    prisma,
    sandbox,
    jobs,
    home,
    artifacts,
    events,
    checkpoints,
    sessionActor,
    verifyPassword,
    emailEnabled,
  } = deps;
  const environmentSignupPolicy = signupPolicyFromEnv(env);
  if (checkpoints)
    mountCheckpointHttp(app, {
      service: checkpoints,
      actor: sessionActor,
      webOrigin: env.webOrigin,
      additionalWebOrigins: env.additionalWebOrigins,
    });
  if (env.agentRuntime === "codex") {
    if (workbenchEnabled())
      mountAgentWorkbench(app, {
        service: new AgentWorkbench({ prisma, sandbox }),
        isDeveloper: developerAccess,
        native: nativeEnabled() ? new NativeControl(prisma, sandbox) : undefined,
        actor: sessionActor,
        webOrigin: env.webOrigin,
        additionalWebOrigins: env.additionalWebOrigins,
        verifyPassword,
      });
    if (teamMessagingEnabled())
      mountTeamWorkflows(app, {
        service: new TeamWorkflowService(prisma, jobs),
        leadership: new TeamLeadershipService(prisma),
        actor: sessionActor,
        webOrigin: env.webOrigin,
        additionalWebOrigins: env.additionalWebOrigins,
        verifyPassword,
      });
    mountAccountAdmin(app, {
      service: new AccountAdminService(
        prisma,
        new TeamService({
          prisma,
          sandbox,
          home,
          jobs,
          events,
          artifacts,
          dataDir: env.dataDir,
          observe: observeTeamComputers,
        }),
        environmentSignupPolicy,
        emailEnabled,
      ),
      actor: sessionActor,
      webOrigin: env.webOrigin,
      additionalWebOrigins: env.additionalWebOrigins,
      verifyPassword,
    });
    mountManagedServiceGuards(app, sessionActor);
    mountManagedUsage(app, sessionActor);
    mountWorkspaceInsights(app, new WorkspaceInsights(prisma, sandbox), sessionActor);
    mountPriorityHttp(app, {
      service: new PriorityService({ prisma, sandbox, dataDir: env.dataDir }),
      actor: sessionActor,
      webOrigin: env.webOrigin,
      additionalWebOrigins: env.additionalWebOrigins,
      verifyPassword,
    });
    mountPolicyWorkflow(app, {
      service: new PolicyWorkflow({ prisma, sandbox }),
      actor: sessionActor,
      webOrigin: env.webOrigin,
      additionalWebOrigins: env.additionalWebOrigins,
    });
  }
  if (!teamMessagingEnabled()) mountDisabledTeamHttp(app, sessionActor);
  if (teamMessagingEnabled())
    mountTeamHttp(app, {
      administrationEnabled: teamEnabled(),
      service: new TeamService({
        prisma,
        sandbox,
        home,
        jobs,
        events,
        artifacts,
        dataDir: env.dataDir,
        observe: observeTeamComputers,
      }),
      actor: sessionActor,
      webOrigin: env.webOrigin,
      additionalWebOrigins: env.additionalWebOrigins,
      verifyPassword,
    });
}
