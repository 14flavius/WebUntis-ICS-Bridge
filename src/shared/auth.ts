import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[a-zA-Z0-9_.-]+$/)
  .transform((value) => value.toLowerCase());
const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);

// Only used within this module: the exported surface is the UserRole type.
const userRoles = ['admin', 'user'] as const;
export type UserRole = (typeof userRoles)[number];

export const setupInput = z.object({
  username: usernameSchema,
  password: passwordSchema,
});
export const createUserInput = setupInput.extend({
  role: z.enum(userRoles).default('user'),
});
export type CreateUserInput = z.infer<typeof createUserInput>;
export const updateUserInput = z
  .object({
    role: z.enum(userRoles).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((input) => input.role !== undefined || input.disabled !== undefined);
export type UpdateUserInput = z.infer<typeof updateUserInput>;
export const passwordResetInput = z.object({ password: passwordSchema });

export interface SetupStatus {
  required: boolean;
  expired: boolean;
  remainingSeconds: number;
}
/** The signed-in user as attached to every authenticated request. */
export interface SessionUser {
  id: string;
  username: string;
  role: UserRole;
  twoFactorEnabled: boolean;
}
/** Administration view: identity and counts only, never another user's data. */
export interface ManagedUser extends SessionUser {
  disabled: boolean;
  createdAt: string;
  accounts: number;
  feeds: number;
}
