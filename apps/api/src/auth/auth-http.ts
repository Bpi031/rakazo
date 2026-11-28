import type { createAuth } from "@rakazo/auth";
import { isBlockedAuthPath } from "@rakazo/auth";
import type { Hono } from "hono";
import { requestClientIp, withClientIp } from "../http/client-ip.js";
import { emptyAuthBodyAsJson, withAuthLibraryFailures } from "./auth-library-failures.js";
import { createAuthResponseAudit } from "./security-audit.js";

export function mountAuthHandler(app: Hono, auth: Pick<ReturnType<typeof createAuth>, "handler">) {
  const auditAuthResponse = createAuthResponseAudit();
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    if (isBlockedAuthPath(path)) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    const ip = requestClientIp(c);
    const response = await withAuthLibraryFailures(() =>
      auth.handler(withClientIp(emptyAuthBodyAsJson(c.req.raw), ip)),
    );
    await auditAuthResponse(path, ip, response);
    return response;
  });
}
