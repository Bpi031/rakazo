import type { JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type {
  CheckpointService,
  createAgentHomeStore,
  createArtifactStore,
  startServerFoundation,
} from "@rakazo/adapters";
import {
  AgentWorkbench,
  NativeControl,
  nativeEnabled,
  observeTeamComputers,
  PolicyWorkflow,
  PriorityService,
  TeamLeadershipService,
  TeamService,
  TeamWorkflowService,
  teamEnabled,
  teamMessagingEnabled,
  workbenchEnabled,
} from "@rakazo/adapters";
import { signupPolicyFromEnv } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import type { Hono } from "hono";
import { AccountAdminService, mountAccountAdmin } from "../account-admin.js";
import { mountAgentWorkbench } from "../agent-workbench-http.js";
import type { requestSessions } from "../auth/request-session.js";
import { mountCheckpointHttp } from "../checkpoints-http.js";
import { developerAccess } from "../developer-access.js";
import type { AppEnv } from "../env.js";
import { mountManagedServiceGuards } from "../managed-services.js";
import { mountManagedUsage } from "../managed-usage.js";
import { mountPriorityHttp } from "../policy-priorities-http.js";
import { mountPolicyWorkflow } from "../policy-workflow-http.js";
import { mountDisabledTeamHttp, mountTeamHttp } from "../team-http.js";
import { mountTeamWorkflows } from "../team-workflows-http.js";
import { mountWorkspaceInsights, WorkspaceInsights } from "../workspace-insights.js";

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
