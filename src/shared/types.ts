import { z } from 'zod';

export const languageSchema = z.enum(['de', 'en']);
export type Language = z.infer<typeof languageSchema>;
const examSourceSchema = z.enum(['exams', 'timetable']);
export type ExamSource = z.infer<typeof examSourceSchema>;
export const accountInput = z.object({
  name: z.string().trim().min(1).max(100),
  school: z.string().trim().min(1).max(200),
  server: z.string().trim().max(300).default(''),
  username: z.string().trim().min(1).max(200),
  password: z.string().min(1).max(512).optional(),
  examSource: examSourceSchema.optional(),
  timezone: z
    .string()
    .default('Europe/Berlin')
    .refine((value) => {
      try {
        new Intl.DateTimeFormat('en', { timeZone: value });
        return true;
      } catch {
        return false;
      }
    }),
});
export type AccountInput = z.infer<typeof accountInput>;
export interface Account extends Omit<AccountInput, 'password'> {
  id: string;
  examSource: ExamSource;
  lastSuccess: string | null;
  lastAttempt: string | null;
  error: string | null;
}
export type CapabilityStatus =
  | 'success'
  | 'empty'
  | 'limited'
  | 'forbidden'
  | 'unavailable'
  | 'authentication'
  | 'server'
  | 'invalid';
export interface Capability {
  name: string;
  status: CapabilityStatus;
  range?: { start: string; end: string };
  warnings?: string[];
  code?: string;
  reason?: 'invalid_credentials' | 'invalid_school' | 'unsupported_account';
}
export interface School {
  displayName: string;
  loginName: string;
  server: string;
  address?: string;
}
