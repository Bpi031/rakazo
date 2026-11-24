import { expect, it, vi } from "vitest";
import {
  assertManagedTeamComputer,
  assertWorkspacePath,
  managedWorkspace,
  managedWorkspaceInstruction,
  workspaceRelativeRoots,
} from "./managed-workspace.js";

it("derives exact own Bot and shared roots for Team while preserving private layout", () => {
  expect(managedWorkspace("dedicated", "a")).toEqual({
    cwd: "/home/rakazo",
    roots: ["/home/rakazo/workspace"],
  });
  expect(workspaceRelativeRoots("team", "a")).toEqual(["bots/a", "shared"]);
  expect(() => managedWorkspace("team", "../other")).toThrow();
  for (const value of ["bots/a/policy.rost", "shared/input.xlsx", "shared"])
    expect(() => assertWorkspacePath(value, workspaceRelativeRoots("team", "a"))).not.toThrow();
  for (const value of [
    "bots/b/policy.rost",
    "bots/ab/policy.rost",
    "shared/../bots/b/a",
    "/shared/a",
    "shared\\a",
    "workspace/a",
  ])
    expect(() => assertWorkspacePath(value, workspaceRelativeRoots("team", "a"))).toThrow();
});

it("requires the same Computer account and Space, including every attached Bot", async () => {
  const db = { bot: { count: vi.fn().mockResolvedValue(0) } };
  const actor = { userId: "u", spaceId: "s" };
  const computer = { id: "c", scope: "team", ...actor };
  await expect(assertManagedTeamComputer(db, computer, actor)).resolves.toBeUndefined();
  expect(db.bot.count).toHaveBeenCalledWith({
    where: { computerId: "c", OR: [{ userId: { not: "u" } }, { spaceId: { not: "s" } }] },
  });
  db.bot.count.mockResolvedValue(1);
  await expect(assertManagedTeamComputer(db, computer, actor)).rejects.toThrow("exclusively");
  db.bot.count.mockClear();
  await expect(
    assertManagedTeamComputer(db, { ...computer, userId: "other" }, actor),
  ).rejects.toThrow();
  await expect(
    assertManagedTeamComputer(db, { ...computer, spaceId: "other" }, actor),
  ).rejects.toThrow();
  expect(db.bot.count).not.toHaveBeenCalled();
});

it("distinguishes absolute shared shell paths from home-relative policy and watch paths", () => {
  const text = managedWorkspaceInstruction("team", "a");
  expect(text).toContain("working directory is /home/rakazo/bots/a");
  expect(text).toContain("absolute /home/rakazo/shared/...");
  expect(text).toContain("home-relative bots/a/... or shared/...");
  expect(text).toContain("use shared/... for shared jobs");
  expect(managedWorkspaceInstruction("dedicated", "a")).toContain("private home");
});
