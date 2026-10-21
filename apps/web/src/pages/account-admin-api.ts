import { readBoundedJsonResponse } from "@rakazo/core";
import { withSpaceHeaders } from "../lib/rpc";

export async function accountAdminApi<T>(
  operation: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const timeout = AbortSignal.timeout(12_000);
  const bound = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch("/api/account-admin/" + operation, {
    method: body === undefined ? "GET" : "POST",
    credentials: "include",
    signal: bound,
    headers: withSpaceHeaders({ "content-type": "application/json" }),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("application/json"))
    throw new Error(
      response.status === 401
        ? "Please sign in again."
        : "Account operation rejected. Refresh and review your role, settings and active work.",
    );
  return readBoundedJsonResponse<T>(response, 256 * 1024, bound);
}
