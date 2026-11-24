/** Paths are derived from the authorized database binding, never model input. */
export function managedWorkspace(scope: string, botId: string) {
  if (scope !== "team") return { cwd: "/home/rakazo", roots: ["/home/rakazo/workspace"] };
  if (!/^[A-Za-z0-9_-]+$/.test(botId)) throw new Error("Invalid Team Bot identity");
  const own = `/home/rakazo/bots/${botId}`;
  return { cwd: own, roots: [own, "/home/rakazo/shared"] };
}

export function workspaceRelativeRoots(scope: string, botId: string) {
  return managedWorkspace(scope, botId).roots.map((root) => root.slice("/home/rakazo/".length));
}

export function managedWorkspaceInstruction(scope: string, botId: string) {
  if (scope !== "team")
    return "This entire computer workspace is your private home. Relative file paths and shell working directories start at its root.";
  const workspace = managedWorkspace(scope, botId);
  return `Your Team Bot working directory is ${workspace.cwd}. Relative shell paths start there. Use absolute /home/rakazo/shared/... for intentionally shared shell work. Rakazo file tools and rule policy/workingDirectory arguments use home-relative bots/${botId}/... or shared/... paths. rost-job-watch output paths are relative to your Bot directory by default; use shared/... for shared jobs. Work within your own Bot directory and shared/. Other bots' directories are separate working areas.`;
}

export function assertWorkspacePath(value: unknown, roots: readonly string[]) {
  if (
    typeof value !== "string" ||
    value.includes("\\") ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) ||
    value.split("/").some((part) => !part || part === "." || part === "..") ||
    !roots.some((root) => value === root || value.startsWith(root + "/"))
  )
    throw new Error("Path is outside this Bot's workspace");
}

export async function assertManagedTeamComputer(
  db: { bot: { count: (query: any) => Promise<number> } },
  computer: { id: string; scope: string; userId: string; spaceId: string },
  actor: { userId: string; spaceId: string },
) {
  if (computer.scope !== "team") return;
  if (
    computer.userId !== actor.userId ||
    computer.spaceId !== actor.spaceId ||
    (await db.bot.count({
      where: {
        computerId: computer.id,
        OR: [{ userId: { not: actor.userId } }, { spaceId: { not: actor.spaceId } }],
      },
    }))
  )
    throw new Error("Managed Team Computer must belong exclusively to this account and Space");
}
