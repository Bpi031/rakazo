import { PLUGIN_SUBMISSIONS_PATH, SERVER_BUILD_HEADER } from "@rakazo/contracts";
import type { Hono } from "hono";
import { cors } from "hono/cors";
import { isTrustedOrigin } from "../auth/trusted-origins.js";
import type { AppEnv } from "../env.js";

export function mountApiCors(app: Hono, env: AppEnv) {
  app.use(
    "*",
    cors({
      origin: (origin, c) => {
        // Anyone may submit a plugin from any site; the endpoint reads no cookies.
        if (c.req.path === PLUGIN_SUBMISSIONS_PATH) return "*";
        if (!origin) return env.webOrigin;
        return isTrustedOrigin(origin, env) ? origin : "";
      },
      credentials: true,
      exposeHeaders: [SERVER_BUILD_HEADER, "x-voice-id"],
    }),
  );
}
