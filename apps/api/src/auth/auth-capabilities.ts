import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { Auth } from "@rakazo/auth";
import { publicSignInProviders } from "@rakazo/auth";
import type { AuthCapabilities } from "@rakazo/contracts";
import type { Hono } from "hono";
import type { BillingService } from "../billing/billing.js";
import type { AppEnv } from "../env.js";
import { nativePasskeys } from "../http/app-association.js";

/** `GET /api/auth/capabilities`: the sign-in options this deployment offers. */
export function mountAuthCapabilities(
  app: Hono,
  {
    env,
    auth,
    email,
    billing,
  }: {
    env: AppEnv;
    auth: Auth;
    email: TransactionalEmailProvider | undefined;
    billing: BillingService | undefined;
  },
) {
  app.get("/api/auth/capabilities", async (c) => {
    const registrationOpen =
      env.desktopStackToken || env.agentRuntime === "codex"
        ? await auth.registrationOpen(c.req.raw.headers)
        : undefined;
    return c.json({
      sso: env.oidc
        ? { name: env.oidc.name, availability: auth.ssoAvailability() ?? "checking" }
        : null,
      providers: publicSignInProviders(env.social, env.oidc),
      passwordAuth: env.passwordAuth !== false,
      passwordReset: env.passwordAuth !== false && Boolean(email),
      resetUrl:
        env.passwordAuth !== false && email ? new URL("/reset-password", env.webOrigin).href : null,
      emailCode: auth.emailCodeSignIn,
      registrationOpen,
      registrationEnabled: registrationOpen,
      billing: Boolean(billing),
      passkeyRpId: auth.passkeyRpId,
      nativePasskeys: nativePasskeys(env, auth.passkeyRpId),
      crispWebsiteId: billing ? (env.crispWebsiteId ?? null) : null,
      demoAccount: env.demoAccount ?? null,
    } satisfies AuthCapabilities);
  });
}
