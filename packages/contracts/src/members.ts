import { z } from 'zod';
import { emailSchema } from './auth';

export const createInvitationSchema = z.object({
  email: emailSchema,
  roleId: z.string().uuid(),
});
export type CreateInvitation = z.infer<typeof createInvitationSchema>;

export interface InvitationResponse {
  id: string;
  email: string;
  role: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  /** Only returned once, when the invitation is created. Share it with the invitee. */
  token?: string;
}

export const acceptInvitationSchema = z.object({
  token: z.string().min(20).max(200),
  /** Password and display name are required only when the e-mail has no account yet. */
  password: z.string().min(1).max(256).optional(),
  displayName: z.string().trim().min(1).max(120).optional(),
});
export type AcceptInvitation = z.infer<typeof acceptInvitationSchema>;

export const changeMemberRoleSchema = z.object({ roleId: z.string().uuid() });
export type ChangeMemberRole = z.infer<typeof changeMemberRoleSchema>;
