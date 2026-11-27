/**
 * Exact-origin normalization and Zod schemas for Privacy Vault website logins and the model-blind browser fill (#17397).
 *
 * An origin is scheme + host + port exactly as `URL#origin` reports it (default
 * ports elided, host lowercased/punycoded). There is no suffix or subdomain
 * matching anywhere: `https://example.com` never matches `https://www.example.com`
 * or `http://example.com`. A pasted full URL is reduced to its origin.
 *
 * The fill and tool-list schemas carry no transforms or refinements, because the
 * CoS tool registry round-trips them through JSON Schema (`z.fromJSONSchema`).
 */

import { z } from 'zod';
import { parseTotpSetupKey } from './totp.js';

const WEBSITE_LOGIN_MAX_ORIGINS = 10;
export const WEBSITE_LOGIN_FILL_FIELDS = Object.freeze(['identifier', 'password', 'totp']);
export const WEBSITE_LOGIN_DEFAULT_FILL_FIELDS = Object.freeze(['identifier', 'password']);

const ORIGIN_MESSAGE = 'must be an http(s) origin such as https://example.com';

/** Canonical `scheme://host[:port]` for an http(s) origin or URL; null for anything else (other schemes, embedded credentials, opaque origins). */
export function normalizeLoginOrigin(raw) {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password || !url.hostname) return null;
  return url.origin;
}

const originSchema = z.string().trim().min(1).max(2048).transform((value, ctx) => {
  const origin = normalizeLoginOrigin(value);
  if (!origin) {
    ctx.addIssue({ code: 'custom', message: ORIGIN_MESSAGE });
    return z.NEVER;
  }
  return origin;
});

const originsSchema = z.array(originSchema).min(1).max(WEBSITE_LOGIN_MAX_ORIGINS)
  .transform((origins) => [...new Set(origins)]);

// Validated here for a clean 400; the service re-parses to store the config.
// The message comes from parseTotpSetupKey, which never echoes the key.
const totpSecretSchema = z.string().trim().max(2048).superRefine((value, ctx) => {
  if (!value) return;
  try { parseTotpSetupKey(value); } catch (error) { ctx.addIssue({ code: 'custom', message: error.message }); }
});

const labelSchema = z.string().trim().min(1).max(200);
const usernameSchema = z.string().min(1).max(512);
const passwordSchema = z.string().min(1).max(4096);
const notesSchema = z.string().max(5000);

// `totpSecret` empty or absent on create means "no 2FA seed".
export const websiteLoginCreateSchema = z.object({
  label: labelSchema,
  origins: originsSchema,
  username: usernameSchema,
  password: passwordSchema,
  totpSecret: totpSecretSchema.optional(),
  notes: notesSchema.optional(),
  subjectId: z.string().uuid().optional(),
}).strict();

// Partial update. An absent key keeps the stored value; `totpSecret: ''` or
// `null` removes the seed, a non-empty value replaces it. The subject is fixed
// at creation, like every other vault record.
export const websiteLoginUpdateSchema = z.object({
  label: labelSchema.optional(),
  origins: originsSchema.optional(),
  username: usernameSchema.optional(),
  password: passwordSchema.optional(),
  totpSecret: totpSecretSchema.nullable().optional(),
  notes: notesSchema.optional(),
}).strict();

export const websiteLoginListQuerySchema = z.object({
  subjectId: z.string().uuid().optional(),
  origin: originSchema.optional(),
}).strict();

export const websiteLoginIdParamsSchema = z.object({ id: z.string().uuid() }).strict();

// Fill candidates span every household subject: the managed browser is the
// operator's, and they may sign in on a consenting member's behalf.
export const browserVaultListInputSchema = z.object({
  origin: z.string().trim().min(1).max(2048).optional(),
}).strict();

const selectorSchema = z.string().trim().min(1).max(512);

export const browserVaultFillSchema = z.object({
  // A CDP target id from the browser catalog or navigate result.
  targetId: z.string().trim().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/),
  loginId: z.string().uuid(),
  fields: z.array(z.enum(WEBSITE_LOGIN_FILL_FIELDS)).min(1).max(WEBSITE_LOGIN_FILL_FIELDS.length).optional(),
  // Optional CSS selectors for pages the field heuristics miss. They are
  // resolved inside the verified top document only, never a frame.
  selectors: z.object({
    identifier: selectorSchema.optional(),
    password: selectorSchema.optional(),
    totp: selectorSchema.optional(),
  }).strict().optional(),
}).strict();
