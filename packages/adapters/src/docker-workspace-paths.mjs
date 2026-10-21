const DOCKER_HOME = "/home/rakazo";

// File endpoints use home-relative paths; shell output uses container-absolute paths.
// Strip only this exact home alias. Other leading slashes remain virtual-root paths.
export function normalizeDockerWorkspacePath(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Invalid computer workspace path");
  }
  const portable = value.replace(/\\/g, "/");
  const segments = portable.split("/").filter(Boolean);
  if (segments.some((part) => part === "." || part === "..")) {
    throw new Error("Path escapes the computer workspace");
  }
  const canonical = `${portable.startsWith("/") ? "/" : ""}${segments.join("/")}`;
  const relative = canonical === DOCKER_HOME ? ""
    : canonical.startsWith(`${DOCKER_HOME}/`) ? canonical.slice(DOCKER_HOME.length + 1)
    : segments.join("/");
  return relative;
}
