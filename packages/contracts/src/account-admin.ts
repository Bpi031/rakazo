import { z } from "zod";

const allowEntry = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .refine(
    (value) =>
      z.email().safeParse(value).success ||
      /^@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(value),
    "Use an email address or @domain",
  );
export const registrationSettingsInput = z
  .object({
    enabled: z.boolean(),
    allowlist: z.array(allowEntry).max(200),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    phrase: z.literal("APPLY REGISTRATION"),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const accountConfirmationInput = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    phrase: z.string().max(170),
    password: z.string().min(1).max(1024),
  })
  .strict();
export const accountProposalInput = z.object({ action: z.unknown() }).strict();

export const registrationPolicySchema = z
  .object({
    enabled: z.boolean(),
    allowlist: z.array(z.string().max(254)).max(200),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const accountAdminViewSchema = z
  .object({
    userId: z.string(),
    organizationId: z.string(),
    canAssignRoles: z.boolean(),
    registration: registrationPolicySchema.nullable(),
    emailDelivery: z.boolean(),
    members: z
      .array(
        z
          .object({
            userId: z.string(),
            name: z.string(),
            email: z.string(),
            verified: z.boolean(),
            role: z.string(),
            state: z.string(),
            protected: z.boolean(),
          })
          .strict(),
      )
      .max(200),
    invitations: z
      .array(
        z
          .object({
            id: z.string(),
            email: z.string(),
            role: z.string(),
            status: z.string(),
            expiresAt: z.string(),
          })
          .strict(),
      )
      .max(100),
    reviews: z
      .array(
        z
          .object({
            id: z.string(),
            action: z.record(z.string(), z.unknown()),
            digest: z.string(),
            status: z.string(),
            expiresAt: z.string(),
          })
          .strict(),
      )
      .max(50),
  })
  .strict();
export type AccountAdminView = z.infer<typeof accountAdminViewSchema>;
export type RegistrationPolicy = z.infer<typeof registrationPolicySchema>;
