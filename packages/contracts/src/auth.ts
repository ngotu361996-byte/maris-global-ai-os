import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
/** 12+ characters; length beats composition rules (NIST SP 800-63B). */
export const passwordSchema = z.string().min(12).max(256);

export const bootstrapRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(1).max(120),
  tenantName: z.string().trim().min(1).max(120),
});
export type BootstrapRequest = z.infer<typeof bootstrapRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(256),
  totp: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const totpVerifyRequestSchema = z.object({ code: z.string().regex(/^\d{6}$/) });
export type TotpVerifyRequest = z.infer<typeof totpVerifyRequestSchema>;

export interface SessionResponse {
  token: string;
  expiresAt: string;
}

export interface MembershipSummary {
  tenantId: string;
  tenantName: string;
  role: string;
}

export interface MeResponse {
  id: string;
  email: string;
  displayName: string;
  mfaEnabled: boolean;
  memberships: MembershipSummary[];
}
