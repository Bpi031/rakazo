import type { Actor } from "@rakazo/contracts";
import { callRequestId } from "@rakazo/contracts";
import type { Context, Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { CallRequestService } from "./call-requests.js";
import { CALL_DOCTOR_SESSION_SECONDS, CallRequestError } from "./call-requests.js";
import { isAllowedWebOrigin } from "./web-origins.js";

const COOKIE = "rakazo_call_doctor";
type Service = Pick<
  CallRequestService,
  | "manage"
  | "upsertDoctors"
  | "managerRemove"
  | "sendCode"
  | "verify"
  | "own"
  | "save"
  | "remove"
  | "logout"
>;

async function jsonBody(c: Context): Promise<unknown> {
  const reader = c.req.raw.body?.getReader();
  if (!reader) throw new CallRequestError(400, "JSON required");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) {
        await reader.cancel();
        throw new CallRequestError(400, "Request is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new CallRequestError(400, "Invalid JSON");
  }
}

export function mountCallRequestHttp(
  app: Hono,
  deps: {
    service: Service;
    actor: (request: Request) => Promise<Actor | null>;
    webOrigin: string;
    additionalWebOrigins?: readonly string[];
  },
) {
  app.all("/api/call-requests/*", async (c) => {
    c.header("cache-control", "no-store");
    try {
      const route = new URL(c.req.url).pathname.slice("/api/call-requests/".length);
      if (c.req.method !== "GET" && c.req.method !== "POST")
        return c.json({ error: "Method not allowed" }, 405);
      if (
        c.req.method === "POST" &&
        (!isAllowedWebOrigin(c.req.header("origin"), deps) ||
          !c.req.header("content-type")?.startsWith("application/json"))
      )
        return c.json({ error: "Same-origin JSON operation required" }, 403);
      const body = c.req.method === "POST" ? await jsonBody(c) : undefined;
      if (route === "manage" || route.startsWith("manage/")) {
        const actor = await deps.actor(c.req.raw);
        if (!actor) return c.json({ error: "Sign in required" }, 401);
        if (route === "manage" && c.req.method === "GET")
          return c.json(await deps.service.manage(actor, c.req.query("month") ?? ""));
        if (route === "manage/doctors" && c.req.method === "POST")
          return c.json(await deps.service.upsertDoctors(actor, body));
        const match = /^manage\/requests\/([A-Za-z0-9_-]{1,160})\/delete$/.exec(route);
        if (match && c.req.method === "POST")
          return c.json(await deps.service.managerRemove(actor, match[1]!));
        return c.json({ error: "Not found" }, 404);
      }
      const match =
        /^([A-Za-z0-9_-]{1,160})(?:\/(code|verify|requests|logout|requests\/[A-Za-z0-9_-]{1,160}\/delete))?$/.exec(
          route,
        );
      if (!match) return c.json({ error: "Not found" }, 404);
      const spaceId = callRequestId.parse(match[1]);
      const action = match[2];
      const token = getCookie(c, COOKIE);
      const cookieOptions = {
        path: `/api/call-requests/${spaceId}`,
        httpOnly: true,
        sameSite: "Strict" as const,
        secure: new URL(deps.webOrigin).protocol === "https:",
      };
      if (!action && c.req.method === "GET")
        return c.json(await deps.service.own(spaceId, token, c.req.query("month") ?? ""));
      if (c.req.method !== "POST") return c.json({ error: "Method not allowed" }, 405);
      if (action === "code") return c.json(await deps.service.sendCode(spaceId, body));
      if (action === "verify") {
        const sessionToken = await deps.service.verify(spaceId, body);
        setCookie(c, COOKIE, sessionToken, {
          ...cookieOptions,
          maxAge: CALL_DOCTOR_SESSION_SECONDS,
        });
        return c.json({ ok: true });
      }
      if (action === "requests") return c.json(await deps.service.save(spaceId, token, body));
      if (action?.startsWith("requests/"))
        return c.json(await deps.service.remove(spaceId, token, action.split("/")[1]!));
      if (action === "logout") {
        await deps.service.logout(spaceId, token);
        setCookie(c, COOKIE, "", { ...cookieOptions, maxAge: 0 });
        return c.json({ ok: true });
      }
      return c.json({ error: "Not found" }, 404);
    } catch (error) {
      if (error instanceof CallRequestError) return c.json({ error: error.message }, error.status);
      if (error instanceof Error && error.name === "ZodError")
        return c.json({ error: "Check the request fields" }, 400);
      return c.json({ error: "Call request operation failed. Please try again." }, 500);
    }
  });
}
