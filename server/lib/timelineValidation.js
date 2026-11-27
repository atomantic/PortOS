// Zod request schemas for the timeline routes.

import { z } from 'zod';

// `preview` (a multipart text field, so it arrives as a string) toggles a
// parse-only dry run — count what would be imported without writing. Only map
// the recognized true/false tokens; any other string is left as-is so Zod
// rejects it with a 400 rather than silently coercing an unknown value to a
// (write-path) real import.
const previewField = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0' || v === '') return false;
  return v; // unrecognized → Zod boolean check fails → 400
}, z.boolean().optional().default(false));

export const importBodySchema = z.object({ preview: previewField });

// WhatsApp adds an optional "your name" so a sender matching it is classified as
// a sent (vs received) message, plus an optional "chat label" — a stable name for
// the conversation that scopes the content-hash dedupe key so distinct chats don't
// collide. Both are blank-to-undefined (a blank multipart field means "not
// provided": yourName → neutral events, chatLabel → legacy un-scoped key) and
// capped to keep the metadata payload bounded.
const blankToUndefinedName = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
  z.string().max(200).optional(),
);

export const whatsappImportBodySchema = z.object({
  preview: previewField,
  yourName: blankToUndefinedName,
  chatLabel: blankToUndefinedName,
  // Settles an ambiguous day/month order; blank multipart field → not provided.
  dateOrder: z.preprocess((v) => (v === '' ? undefined : v), z.enum(['mdy', 'dmy']).optional()),
});

export const dayQuerySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

// The store accepts connector-defined source identifiers. Require an exact,
// non-empty source instead of duplicating its evolving producer set here.
export const eraseQuerySchema = z.object({
  source: z.string().min(1),
  kind: z.string().max(64).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});

// POST /api/timeline/import/gmail — bulk-backfill Gmail full-history metadata from
// a Google Takeout `.mbox`. Unlike the other importers this is PATH-BASED (a JSON
// body, not a multipart upload): the Gmail mbox is routinely multiple GB and does
// not fit the 200MB upload flow, so the server streams a local file/folder the
// user names. Header metadata only (never the body) → message.sent/message.received
// events under source `gmail` (dedupe on the RFC-822 Message-ID). `preview=true`
// streams + counts without writing. `yourEmail` (optional, blank → ignored) refines
// sent/received direction when the export's Gmail labels are absent.
export const gmailImportSchema = z.object({
  path: z.string().trim().min(1).max(4096),
  preview: z.boolean().optional().default(false),
  yourEmail: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? undefined : v),
    z.string().max(320).optional(),
  ),
});
