import type { CheckpointView } from "@rakazo/contracts";
import { checkpointCopy, checkpointHttpError } from "./checkpoint-i18n";
import { withSpaceHeaders } from "./query/rpc";

export async function checkpointApi<T>(
  route: string,
  botId: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
  spaceId?: string | null,
): Promise<T> {
  const response = await fetch(
    `/api/checkpoints${route}${body === undefined ? `?botId=${encodeURIComponent(botId)}` : ""}`,
    {
      method: body === undefined ? "GET" : "POST",
      credentials: "include",
      cache: "no-store",
      headers: withSpaceHeaders(body === undefined ? {} : { "content-type": "application/json" }, spaceId),
      signal: AbortSignal.any([
        ...(signal ? [signal] : []),
        AbortSignal.timeout(body === undefined ? 15000 : 310000),
      ]),
      ...(body === undefined ? {} : { body: JSON.stringify({ ...body, botId }) }),
    },
  );
  if (!response.headers.get("content-type")?.includes("application/json"))
    throw new Error(checkpointCopy().operationError);
  const value = await response.json();
  if (!response.ok) throw new Error(checkpointHttpError(value?.code, value?.error));
  return value as T;
}

/** Ignore in-flight recovery generations; reload only when the workspace is usable again. */
export function checkpointNeedsReload(
  previous: Pick<CheckpointView, "generation" | "blocked">,
  next: Pick<CheckpointView, "generation" | "blocked">,
): boolean {
  return !next.blocked && (previous.blocked || previous.generation !== next.generation);
}
