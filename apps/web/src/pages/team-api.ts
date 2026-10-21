import { withSpaceHeaders } from "../lib/rpc";

export class TeamUnavailable extends Error {
  constructor(public readonly disabled: boolean, message: string) { super(message); }
}

export async function teamApi<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch("/api/team/" + route, {
    method: body === undefined ? "GET" : "POST", credentials: "include",
    headers: withSpaceHeaders({ "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new TeamUnavailable(false, "Team service is unavailable. Please try again later.");
  let value;
  try { value = await response.json(); }
  catch { throw new TeamUnavailable(false, "Team service returned an invalid response. Please try again later."); }
  if (!response.ok) {
    if (value?.code === "TEAM_DISABLED")
      throw new TeamUnavailable(true, "Team administration is not enabled on this deployment.");
    throw new TeamUnavailable(false, response.status === 401 ? "Please sign in again." :
      "Operation rejected. Check your role, current review and service availability.");
  }
  return value as T;
}
