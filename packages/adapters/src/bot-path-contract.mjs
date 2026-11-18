export const BOT_HOME = "/home/rakazo";
export const BOT_WORKSPACE = `${BOT_HOME}/workspace`;
export const BOT_PATH_GUIDANCE = `Path contract: shell cwd is /home/rakazo; workspace is /home/rakazo/workspace.
File tools use home-relative paths, such as workspace/case/policy.rost. New owned uploads are staged under workspace/inputs/uploads using artifact IDs.
Policy/report/workbench fields use workspace/...; policy workingDirectory is workspace or workspace/case, preserving the actual input-resolution directory.
Completion-watch rostJobOut is workspace-relative: case/job. Exact /home/rakazo/workspace/... and workspace/... job aliases are translated by the adapter.
Installed /opt/... guides use skill_read or shell, not home-file tools. Shell commands and policy contents are not rewritten.`;

class PathRejected extends Error {
  constructor(field, domain) {
    super("Path does not match the tool's declared base");
    this.field = field;
    this.domain = domain;
  }
}

function homeRelative(value, field) {
  if (typeof value !== "string" || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value))
    throw new PathRejected(field, "home-relative");
  if (value === BOT_HOME) return "";
  const relative = value.startsWith(BOT_HOME + "/") ? value.slice(BOT_HOME.length + 1) : value;
  if (relative.startsWith("/") || relative && relative.split("/").some((p) => !p || p === "." || p === ".."))
    throw new PathRejected(field, "home-relative");
  return relative;
}

function workspaceRelative(value, field, rootAllowed = false) {
  const relative = homeRelative(value, field);
  if (rootAllowed && relative === "workspace") return relative;
  if (!relative.startsWith("workspace/")) throw new PathRejected(field, "workspace-prefixed");
  return relative;
}

function jobRelative(value, field) {
  let relative;
  if (typeof value === "string" && (value.startsWith("/") || value === "workspace" || value.startsWith("workspace/"))) {
    relative = workspaceRelative(value, field).slice("workspace/".length);
  } else relative = homeRelative(value, field);
  if (!relative) throw new PathRejected(field, "workspace-relative-job");
  return relative;
}

// Pure spelling translation for declared fields only. Authorization, ownership,
// source pins and filesystem checks still run on the canonical arguments.
export function canonicalToolPaths(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return { args };
  const result = { ...args };
  const translate = (field, operation) => {
    if (Object.hasOwn(result, field) && result[field] !== undefined && !(field === "rostJobOut" && result[field] === null))
      result[field] = operation(result[field], field);
  };
  try {
    if (["read_file", "list_files", "write_file", "attach_file"].includes(tool)) translate("path", (v, f) => {
      const relative = homeRelative(v, f);
      if (!relative && tool !== "list_files") throw new PathRejected(f, "home-relative-file");
      return relative;
    });
    if (["workspace_read", "workspace_list"].includes(tool)) translate("path", (v, f) => workspaceRelative(v, f, tool === "workspace_list"));
    if (tool === "present_report") translate("report_path", workspaceRelative);
    if (tool === "rule_priorities") {
      translate("policy", workspaceRelative);
      translate("workingDirectory", (v, f) => workspaceRelative(v, f, true));
    }
    if (["schedule_create", "schedule_update"].includes(tool)) translate("rostJobOut", jobRelative);
    return { args: result };
  } catch (error) {
    if (!(error instanceof PathRejected)) throw error;
    return { error: { code: "ROST_TOOL_PATH", error: "The path does not match this tool's declared base.",
      field: error.field, expectedBase: error.domain, action: BOT_PATH_GUIDANCE,
      toolExecuted: false, solveStarted: false } };
  }
}
