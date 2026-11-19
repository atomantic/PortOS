/**
 * Brain domain/service schemas — pure leaf imported by services (`brain.js`,
 * `idealoomObsidian.js`, `threadSync.js`) so `brainValidation.js` route schemas
 * stay isolated from the federated service graph.
 */

import { z } from 'zod';
import { canonicalThreadRefKind } from './threadRefKinds.js';
import { THREAD_STATUSES, THREAD_PRIORITIES } from './brainThreads.js';

// Destination enum. `links` is reachable only from the bare-URL capture
// short-circuit (a pasted URL is filed straight to the links collection) — the
// classifier never picks it and the manual resolve/fix paths exclude it, since
// filing an arbitrary note as a bookmark needs a URL it doesn't have.
export const destinationEnum = z.enum(['people', 'projects', 'ideas', 'admin', 'memories', 'links', 'unknown']);

// Destinations the classifier may pick — everything but `links`, which needs a
// URL no model extracted. A hallucinated one falls to needs_review instead of
// reaching fileToDestination.
export const classifierDestinationEnum = destinationEnum.exclude(['links']);

// Destinations a user can file to by hand from the inbox (see fileToDestination).
export const manualDestinationEnum = classifierDestinationEnum.exclude(['unknown']);

// Project status enum
export const projectStatusEnum = z.enum(['active', 'waiting', 'blocked', 'someday', 'done']);

// Idea status enum
export const ideaStatusEnum = z.enum(['active', 'done']);

// Admin status enum
export const adminStatusEnum = z.enum(['open', 'waiting', 'done']);

// IdeaLoom lists are intentionally distinct from native Brain ideas. They are
// machine-local list documents, so neither their shape nor their sync metadata
// belongs to the federated Brain entity schemas above.
export const ideaLoomListStatusEnum = z.enum(['draft', 'completed']);

export const ideaLoomListInputSchema = z.object({
  prompt: z.string().min(1).max(10000),
  title: z.string().min(1).max(200),
  category: z.string().min(1).max(100),
  status: ideaLoomListStatusEnum.optional().default('draft'),
  help: z.string().max(5000).optional(),
  ideas: z.array(z.string().trim().min(1).max(2000)).max(500)
}).strict();

// --- Extracted field schemas for AI classification ---

// Extracted People fields
export const extractedPeopleSchema = z.object({
  name: z.string().min(1).max(200),
  context: z.string().max(2000).optional().default(''),
  followUps: z.array(z.string().max(500)).optional().default([]),
  lastTouched: z.string().datetime().nullable().optional(),
  tags: z.array(z.string().max(50)).optional().default([])
});

// Extracted Project fields
export const extractedProjectSchema = z.object({
  name: z.string().min(1).max(200),
  status: projectStatusEnum.optional().default('active'),
  nextAction: z.string().min(1).max(500),
  notes: z.string().max(5000).optional().default(''),
  tags: z.array(z.string().max(50)).optional().default([])
});

// Extracted Idea fields
export const extractedIdeaSchema = z.object({
  title: z.string().min(1).max(200),
  status: ideaStatusEnum.optional().default('active'),
  oneLiner: z.string().min(1).max(500),
  notes: z.string().max(5000).optional().default(''),
  tags: z.array(z.string().max(50)).optional().default([])
});

// Extracted Admin fields
export const extractedAdminSchema = z.object({
  title: z.string().min(1).max(200),
  status: adminStatusEnum.optional().default('open'),
  dueDate: z.string().datetime().nullable().optional(),
  nextAction: z.string().max(500).nullable().optional(),
  notes: z.string().max(5000).optional().default('')
});

// Extracted Memory fields
export const extractedMemorySchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10000).optional().default(''),
  mood: z.string().max(50).nullable().optional(),
  tags: z.array(z.string().max(50)).optional().default([])
});

// AI Classifier output schema (what we expect from the AI)
export const classifierOutputSchema = z.object({
  destination: classifierDestinationEnum,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  cleanedUp: z.string().max(10000).optional().default(''),
  thoughts: z.string().max(2000).optional().default(''),
  extracted: z.record(z.unknown()),
  reasons: z.array(z.string()).max(5).optional().default([])
});

// Daily digest AI output schema
export const digestOutputSchema = z.object({
  digestText: z.string(),
  topActions: z.array(z.string()).max(3),
  stuckThing: z.string(),
  smallWin: z.string()
});

// Weekly review AI output schema
export const reviewOutputSchema = z.object({
  reviewText: z.string(),
  whatHappened: z.array(z.string()).max(5),
  biggestOpenLoops: z.array(z.string()).max(3),
  suggestedActionsNextWeek: z.array(z.string()).max(3),
  recurringTheme: z.string()
});

// Vocabularies live in the pure leaf (`lib/brainThreads.js`) so the client
// renders its pickers from the same arrays these enums validate against.
export const threadStatusEnum = z.enum(THREAD_STATUSES);
export const threadPriorityEnum = z.enum(THREAD_PRIORITIES);

// A ref's `kind` is validated as a SHAPE, not against THREAD_REF_KIND_IDS. A
// peer running newer code can sync a thread naming a kind this build has never
// heard of, and a strict enum would reject the user's own record on the next
// local edit; `resolveThreadRefs` degrades an unrecognized kind to
// `{ resolved: false, reason: 'unknown-kind' }` instead. The pattern still
// rejects a typo'd free-text kind and anything that could confuse a route param.
// Canonicalized BEFORE the shape check so a legacy spelling a catalog ref row
// still carries (`writersRoom`) is accepted and STORED canonically, rather than
// 400ing on the slug pattern and stranding the attach.
export const threadRefKindValue = z.preprocess(
  (value) => canonicalThreadRefKind(value),
  z.string().trim().min(1).max(40)
    .regex(/^[a-z0-9]+([-.][a-z0-9]+)*$/, 'kind must be a lowercase dot/dash slug'),
);

// An external ref's id IS its URL (up to 2000 chars), which is why this is not
// bounded to an id-sized string.
export const threadRefSchema = z.object({
  kind: threadRefKindValue,
  id: z.string().trim().min(1).max(2000),
  // Cached display string so rendering a list of threads never fans out to N
  // resolvers. Advisory only — `resolveThreadRefs` prefers what the live target
  // says and falls back to this.
  label: z.string().trim().max(300).optional().default('')
}).strict();

export const threadInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  status: threadStatusEnum.optional().default('open'),
  priority: threadPriorityEnum.optional().default('normal'),
  // The ONE concrete next step. Empty is meaningful ("nothing to do right now"),
  // so it is a default rather than a required field.
  nextAction: z.string().trim().max(500).optional().default(''),
  notes: z.string().max(20000).optional().default(''),
  waitingOn: z.string().trim().max(200).optional().default(''),
  // Null is the explicit "no due date" value and must stay reachable on a PUT:
  // threadUpdateSchema strips the default, so an OMITTED key preserves the
  // stored date while an explicit `null` clears it (the absent-vs-empty rule).
  dueAt: z.string().datetime().nullable().optional().default(null),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional().default([]),
  pinned: z.boolean().optional().default(false),
  // Bounded: a thread is a tracked topic, not a graph. 100 is the same ceiling
  // the resolver's per-tuple probing is sized for.
  refs: z.array(threadRefSchema).max(100).optional().default([])
});
