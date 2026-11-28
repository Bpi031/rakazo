import { MCP_APP_MIME_TYPE, STEP_SCREENSHOT_MIME_TYPES } from "@rakazo/contracts";
import { usesManagedComputers } from "../computers/computers.js";
import type { PrismaClient } from "../database/client.js";
import { Prisma } from "../database/client.js";
import { isUniqueViolation } from "../database/prisma-errors.js";
import { IsolationError } from "../database/scope.js";

/**
 * Files people and bots see. An MCP app's HTML is kept as an artifact only for its chat card, and
 * a reply's kept screenshot only for the bot's later turns.
 */
export const HIDDEN_ARTIFACT_MIME_TYPES = [MCP_APP_MIME_TYPE, ...STEP_SCREENSHOT_MIME_TYPES];
export const LISTED_ARTIFACT = {
  checkpointHidden: false,
  mimeType: { notIn: HIDDEN_ARTIFACT_MIME_TYPES },
} satisfies Prisma.ArtifactWhereInput;

type ArtifactVersionScope = {
  spaceId: string;
  botId: string;
  userId?: string;
  groupId?: string | null;
  name: string;
};

export async function resolveNextArtifactVersion(
  prisma: Pick<PrismaClient, "artifact">,
  params: ArtifactVersionScope,
): Promise<{ rootArtifactId: string | null; version: number }> {
  const managed = usesManagedComputers();
  if (managed && !params.userId) throw new IsolationError("Missing artifact owner");
  const owner = managed ? { userId: params.userId } : {};
  const previous = await prisma.artifact.findFirst({
    where: {
      spaceId: params.spaceId,
      botId: params.botId,
      ...owner,
      groupId: params.groupId ?? null,
      name: { equals: params.name, mode: "insensitive" },
      standalone: false,
      // An MCP app's hidden HTML never starts or joins a file's version history.
      ...LISTED_ARTIFACT,
    },
    orderBy: [{ version: "desc" }, { createdAt: "desc" }],
    select: { id: true, rootArtifactId: true, version: true },
  });
  if (!previous) return { rootArtifactId: null, version: 1 };
  const rootArtifactId = previous.rootArtifactId ?? previous.id;
  const latest = await prisma.artifact.findFirst({
    where: {
      spaceId: params.spaceId,
      botId: params.botId,
      ...owner,
      OR: [{ id: rootArtifactId }, { rootArtifactId }],
    },
    orderBy: { version: "desc" },
    select: { version: true },
  });
  return {
    rootArtifactId,
    version: Math.max(previous.version, latest?.version ?? 0) + 1,
  };
}

const MAX_VERSION_ALLOCATION_ATTEMPTS = 5;

type ArtifactVersionWrite = {
  rootArtifactId: string | null;
  version: number;
};

// In managed spaces a file family belongs to its publishing account.
// Advisory lock queues same-name publishes; retry a unique family-version clash.
export async function withResolvedArtifactVersion<T>(
  prisma: Pick<PrismaClient, "$transaction">,
  params: ArtifactVersionScope,
  attempt: (db: Prisma.TransactionClient, version: ArtifactVersionWrite) => Promise<T>,
  options?: { timeout?: number },
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < MAX_VERSION_ALLOCATION_ATTEMPTS; i++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$queryRaw(Prisma.sql`
          SELECT pg_advisory_xact_lock(hashtextextended(${artifactVersionLockKey(params)}, 0))::text AS "lock"
        `);
        const version = await resolveNextArtifactVersion(tx, params);
        return await attempt(tx, version);
      }, options);
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

// Same identity as the name lookup, so those publishes share one lock.
function artifactVersionLockKey(params: ArtifactVersionScope): string {
  const keys = [params.spaceId, params.botId, params.groupId ?? "", params.name.toLowerCase()];
  if (usesManagedComputers()) keys.push(params.userId ?? "");
  return keys.join("\u001f");
}
