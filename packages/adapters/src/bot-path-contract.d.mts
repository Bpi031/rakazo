type Workspace = { cwd: string; roots: readonly string[] };

export const BOT_HOME: string;
export const BOT_WORKSPACE: string;
export const BOT_PATH_GUIDANCE: string;
export function botPathGuidance(workspace?: Workspace): string;
export function canonicalToolPaths<T>(
  tool: string,
  args: T,
  workspace?: Workspace,
):
  | { args: T }
  | {
      error: {
        code: "ROST_TOOL_PATH";
        error: string;
        field: string;
        expectedBase: string;
        action: string;
        toolExecuted: false;
        solveStarted: false;
      };
    };
