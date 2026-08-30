import { z } from 'zod';
import { partialWithoutDefaults, optionalBooleanMap } from './zodCompat.js';
import { REPO_INTAKE_KEYS } from './repoIntakeActions.js';
import { EFFORT_LEVELS } from './providerModels.js';
import { MAX_QUALITY } from './spacedRepetition.js';

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

// Inbox log status enum
export const inboxStatusEnum = z.enum(['classifying', 'filed', 'needs_review', 'corrected', 'done', 'error']);

// AI configuration schema
export const aiConfigSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  promptTemplateId: z.string(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional()
});

// Classification result schema
export const classificationSchema = z.object({
  destination: destinationEnum,
  confidence: z.number().min(0).max(1),
  title: z.string().min(1).max(200),
  cleanedUp: z.string().max(10000).optional(),
  thoughts: z.string().max(2000).optional(),
  extracted: z.record(z.unknown()),
  reasons: z.array(z.string()).max(5).optional()
});

// Filed info schema
export const filedSchema = z.object({
  destination: destinationEnum.exclude(['unknown']),
  destinationId: z.string().guid()
});

// Correction schema
export const correctionSchema = z.object({
  correctedAt: z.string().datetime(),
  previousDestination: destinationEnum,
  newDestination: manualDestinationEnum,
  note: z.string().max(500).optional()
});

// Error schema
export const errorSchema = z.object({
  message: z.string(),
  stack: z.string().optional()
});

// Inbox Log Record schema
export const inboxLogRecordSchema = z.object({
  id: z.string().guid(),
  capturedText: z.string().min(1).max(10000),
  capturedAt: z.string().datetime(),
  source: z.literal('brain_ui'),
  ai: aiConfigSchema.optional(),
  classification: classificationSchema.optional(),
  status: inboxStatusEnum,
  filed: filedSchema.optional(),
  correction: correctionSchema.optional(),
  error: errorSchema.optional(),
  // User-marked creative note (see captureInputSchema.creative). Drives the
  // "Send creative notes to Catalog" batch action in the inbox.
  creative: z.boolean().optional(),
  // ISO timestamp stamped once this creative note's catalog ingest COMMITS
  // (not on mere navigation). Drives the inbox's "already consumed" filter so a
  // batch-sent note drops out of the "ready to become ingredients" banner and
  // can't be accidentally re-sent. Absent ⇒ still re-sendable.
  sentToCatalogAt: z.string().datetime().optional()
});

// People Record schema
export const peopleRecordSchema = z.object({
  id: z.string().guid(),
  name: z.string().min(1).max(200),
  context: z.string().max(2000).optional().default(''),
  followUps: z.array(z.string().max(500)).optional().default([]),
  lastTouched: z.string().datetime().optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Project Record schema
export const projectRecordSchema = z.object({
  id: z.string().guid(),
  name: z.string().min(1).max(200),
  status: projectStatusEnum,
  nextAction: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Idea Record schema
export const ideaRecordSchema = z.object({
  id: z.string().guid(),
  title: z.string().min(1).max(200),
  status: ideaStatusEnum.default('active'),
  oneLiner: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Admin Record schema
export const adminRecordSchema = z.object({
  id: z.string().guid(),
  title: z.string().min(1).max(200),
  status: adminStatusEnum,
  dueDate: z.string().datetime().optional(),
  nextAction: z.string().max(500).optional(),
  notes: z.string().max(5000).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Memory Record schema (journal entries, daily notes, personal memories)
export const memoryRecordSchema = z.object({
  id: z.string().guid(),
  title: z.string().min(1).max(200),
  content: z.string().max(10000).optional().default(''),
  mood: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).optional().default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Meta/Settings schema
export const brainSettingsSchema = z.object({
  version: z.number().int().positive().default(1),
  confidenceThreshold: z.number().min(0).max(1).default(0.6),
  dailyDigestTime: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  weeklyReviewTime: z.string().regex(/^\d{2}:\d{2}$/).default('00:00'),
  weeklyReviewDay: z.enum(['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']).default('sunday'),
  defaultProvider: z.string().default('lmstudio'),
  defaultModel: z.string().default('gptoss-20b'),
  lastDailyDigest: z.string().datetime().optional(),
  lastWeeklyReview: z.string().datetime().optional()
});

// Digest Record schema
export const digestRecordSchema = z.object({
  id: z.string().guid(),
  generatedAt: z.string().datetime(),
  digestText: z.string().max(2000),
  topActions: z.array(z.string().max(200)).max(3),
  stuckThing: z.string().max(200),
  smallWin: z.string().max(200),
  ai: aiConfigSchema.optional()
});

// Weekly Review Record schema
export const reviewRecordSchema = z.object({
  id: z.string().guid(),
  generatedAt: z.string().datetime(),
  reviewText: z.string().max(3000),
  whatHappened: z.array(z.string().max(200)).max(5),
  biggestOpenLoops: z.array(z.string().max(200)).max(3),
  suggestedActionsNextWeek: z.array(z.string().max(200)).max(3),
  recurringTheme: z.string().max(500),
  ai: aiConfigSchema.optional()
});

// --- Input schemas for API endpoints ---

// Opt-in post-clone agent actions for a captured GitHub repo URL. Keys derive
// from REPO_INTAKE_KEYS so the wire contract can't drift from the normalizer
// that reads it (server/lib/repoIntakeActions.js).
export const repoIntakeSchema = z.object(optionalBooleanMap(REPO_INTAKE_KEYS)).extend({
  targetAppId: z.string().trim().min(1).max(200).optional(),
  studyContext: z.string().trim().max(5000).optional(),
  // These pins apply only to the opt-in repo-study CoS task. Empty values are
  // the UI's "use the configured default" sentinel and are omitted before
  // the link stores the intake request.
  providerId: z.string().trim().min(1).max(120).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  effort: z.preprocess(
    value => typeof value === 'string' ? (value.trim().toLowerCase() || undefined) : value,
    z.enum(EFFORT_LEVELS).optional()
  )
});
const repoIntakeInputSchema = repoIntakeSchema.optional();

// Capture input schema
export const captureInputSchema = z.object({
  text: z.string().min(1).max(10000),
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional(),
  // Opt-in flag: the user marked this note as a creative idea at capture time
  // (vs a todo/reference). Creative notes are later batch-sendable into the
  // creative catalog as ingredients (see catalog brain-bridge ingest).
  creative: z.boolean().optional(),
  // Post-clone agent actions for a bare GitHub repo URL. `targetAppId` selects
  // the managed app whose tracker receives repo-study issues; omitted means
  // PortOS for backward compatibility. Ignored for every other capture.
  repoIntake: repoIntakeInputSchema
});

// Resolve review input schema
export const resolveReviewInputSchema = z.object({
  inboxLogId: z.string().guid(),
  destination: manualDestinationEnum,
  editedExtracted: z.record(z.unknown()).optional()
});

// Fix classification input schema
export const fixInputSchema = z.object({
  inboxLogId: z.string().guid(),
  newDestination: manualDestinationEnum,
  updatedFields: z.record(z.unknown()).optional(),
  note: z.string().max(500).optional()
});

// Update inbox entry input schema
export const updateInboxInputSchema = z.object({
  capturedText: z.string().min(1).max(10000)
});

// Batch mark a set of creative inbox notes as consumed by a catalog ingest that
// just committed. Bounded to keep a malformed/runaway payload from stamping the
// whole inbox in one call.
export const markInboxSentToCatalogSchema = z.object({
  ids: z.array(z.string().guid()).min(1).max(200)
}).strict();

// Create/Update People input schema
export const peopleInputSchema = z.object({
  name: z.string().min(1).max(200),
  context: z.string().max(2000).optional(),
  followUps: z.array(z.string().max(500)).optional(),
  lastTouched: z.string().datetime().optional(),
  tags: z.array(z.string().max(50)).optional()
});

// Create/Update Project input schema
export const projectInputSchema = z.object({
  name: z.string().min(1).max(200),
  status: projectStatusEnum.optional().default('active'),
  nextAction: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional()
});

// Create/Update Idea input schema
export const ideaInputSchema = z.object({
  title: z.string().min(1).max(200),
  status: ideaStatusEnum.optional().default('active'),
  oneLiner: z.string().min(1).max(500),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).optional()
});

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

// Settings deliberately contain only integration switches and a vault id.
// Paths and note hashes stay on local list records and never cross this API.
export const ideaLoomSettingsInputSchema = z.object({
  enabled: z.boolean().optional(),
  obsidianVaultId: z.string().uuid().nullable().optional(),
  autoSync: z.boolean().optional()
}).strict();

export const ideaLoomImportInputSchema = z.preprocess((value) => value ?? {}, z.object({}).strict());

// `recreateMissing` is the explicit recovery switch for a vault note the user
// deleted. It is only ever reachable from a user-initiated sync request —
// automatic sync omits it, so it can never resurrect a deleted note on its own.
export const ideaLoomSyncInputSchema = z.preprocess((value) => value ?? {}, z.object({
  listId: z.string().uuid().optional(),
  recreateMissing: z.boolean().optional().default(false)
}).strict());

// Create/Update Admin input schema
export const adminInputSchema = z.object({
  title: z.string().min(1).max(200),
  status: adminStatusEnum.optional().default('open'),
  dueDate: z.string().datetime().optional(),
  nextAction: z.string().max(500).optional(),
  notes: z.string().max(5000).optional()
});

// Create/Update Memory input schema
export const memoryInputSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().max(10000).optional(),
  mood: z.string().max(50).optional(),
  tags: z.array(z.string().max(50)).optional(),
  // Provenance fields stamped by importers (e.g. chatgptImport) — kept on the
  // create/update payload shape so schema validation matches what createMemoryEntry
  // persists. `sourceCreatedAt`/`sourceUpdatedAt` drive the recency sort in the
  // memory list (see memoryRecencyMs in brainStorage.js).
  source: z.string().max(100).optional(),
  sourceRef: z.string().max(300).optional(),
  sourceCreatedAt: z.string().datetime().nullable().optional(),
  sourceUpdatedAt: z.string().datetime().nullable().optional()
});

// Settings update input schema
// partialWithoutDefaults (not .partial()) so a PATCH that touches only one
// setting doesn't inject the other fields' defaults (e.g. defaultProvider:
// 'lmstudio') and overwrite the stored values — Zod 4's .partial() keeps inner
// defaults (see zodCompat.js).
export const settingsUpdateInputSchema = partialWithoutDefaults(brainSettingsSchema).omit({ version: true, lastDailyDigest: true, lastWeeklyReview: true });

// Inbox query schema
export const inboxQuerySchema = z.object({
  status: inboxStatusEnum.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

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

// =============================================================================
// LINKS SCHEMAS
// =============================================================================

// Link type enum
export const linkTypeEnum = z.enum(['github', 'article', 'documentation', 'tool', 'reference', 'other']);

// Link Record schema
export const linkRecordSchema = z.object({
  id: z.string().guid(),
  url: z.string().url(),
  title: z.string().min(1).max(500),
  description: z.string().max(2000).optional().default(''),
  linkType: linkTypeEnum.default('other'),
  tags: z.array(z.string().max(50)).optional().default([]),
  // GitHub-specific fields
  isGitHubRepo: z.boolean().default(false),
  gitHubOwner: z.string().max(100).optional(),
  gitHubRepo: z.string().max(100).optional(),
  localPath: z.string().max(500).optional(),
  cloneStatus: z.enum(['pending', 'cloning', 'cloned', 'failed', 'none']).default('none'),
  cloneError: z.string().max(500).optional(),
  // The instance currently responsible for an in-flight clone. This differs
  // from immutable originInstanceId when a peer retries a shared link.
  cloneInstanceId: z.string().optional(),
  malwareScan: z.object({
    reportId: z.string().uuid(),
    taskId: z.string().optional(),
    // `queued` is stamped when the capture-time checkbox dispatches the scan
    // right after the clone; finalizeMalwareScan replaces it on completion.
    status: z.enum(['queued', 'completed', 'failed']).optional(),
    verdict: z.enum(['CLEAN', 'CAUTION', 'DANGEROUS']).nullable().optional(),
    completedAt: z.string().datetime().optional()
  }).optional(),
  // What the user asked to happen after the clone lands (capture-time checkboxes).
  repoIntake: repoIntakeSchema.optional(),
  // The queued `repo-study` run, once dispatched.
  repoStudy: z.object({
    taskId: z.string().optional(),
    queuedAt: z.string().datetime().optional()
  }).optional(),
  // Bucket grouping (nullable = ungrouped)
  bucketId: z.string().guid().nullable().optional(),
  bucketOrder: z.number().int().optional(),
  // Metadata
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Create/Update Link input schema
export const linkInputSchema = z.object({
  url: z.string().url(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  linkType: linkTypeEnum.optional(),
  tags: z.array(z.string().max(50)).optional(),
  bucketId: z.string().guid().nullable().optional(),
  bucketOrder: z.number().int().optional(),
  autoClone: z.boolean().optional().default(true),
  // Post-clone agent actions, same contract as the capture box's checkboxes.
  repoIntake: repoIntakeInputSchema
});

// Update Link input schema (partial)
export const linkUpdateInputSchema = z.object({
  url: z.string().url().optional(),
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(2000).optional(),
  linkType: linkTypeEnum.optional(),
  tags: z.array(z.string().max(50)).optional(),
  bucketId: z.string().guid().nullable().optional(),
  bucketOrder: z.number().int().optional()
});

// Links query schema
export const linksQuerySchema = z.object({
  linkType: linkTypeEnum.optional(),
  // Query params arrive as strings; z.coerce.boolean() treats any non-empty
  // string (including "false") as true, so parse the string value explicitly.
  isGitHubRepo: z.preprocess(
    v => (typeof v === 'string' ? v === 'true' : v),
    z.boolean()
  ).optional(),
  // LinksTab does its own filtering, search, and bucket assignment client-side
  // over the full set — so the upper cap has to be large enough to return every
  // saved link in one round-trip. 5000 is plenty of headroom for a single-user
  // bookmark collection without being unbounded.
  limit: z.coerce.number().int().min(1).max(5000).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0)
});

// =============================================================================
// BUCKET SCHEMAS (bookmark groups for links)
// =============================================================================

// A small preset palette keyed to the port design tokens (plus a neutral default)
export const bucketColorEnum = z.enum([
  'accent', 'success', 'warning', 'error', 'purple', 'pink', 'cyan', 'slate'
]);

// Bucket Record schema
export const bucketRecordSchema = z.object({
  id: z.string().guid(),
  name: z.string().min(1).max(100),
  color: bucketColorEnum.default('accent'),
  icon: z.string().max(50).optional().default(''),
  order: z.number().int().default(0),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

// Create Bucket input schema
export const bucketInputSchema = z.object({
  name: z.string().min(1).max(100),
  color: bucketColorEnum.optional(),
  icon: z.string().max(50).optional()
});

// Update Bucket input schema (partial)
export const bucketUpdateInputSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  color: bucketColorEnum.optional(),
  icon: z.string().max(50).optional(),
  order: z.number().int().optional()
});

// Reorder buckets input schema (ordered list of bucket ids)
export const bucketReorderSchema = z.object({
  ids: z.array(z.string().guid()).min(1)
});

// Batch link reorder (POST /api/brain/links/reorder) — applies a dense
// bucketOrder renumbering for one drag gesture in a single atomic write, so a
// multi-chip reorder can't lose-update the shared links store the way N
// concurrent single-record PUTs can.
export const linkReorderSchema = z.object({
  updates: z.array(z.object({
    id: z.string().guid(),
    bucketId: z.string().guid().nullable(),
    bucketOrder: z.number().int()
  })).min(1)
});

// =============================================================================
// SYNC SCHEMAS
// =============================================================================

// Brain sync query schema (GET /api/brain/sync?since=N&limit=100)
export const brainSyncQuerySchema = z.object({
  since: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(100)
});

// Brain sync change object schema
const brainSyncChangeSchema = z.object({
  seq: z.number().int(),
  op: z.enum(['create', 'update', 'delete']),
  type: z.string(),
  id: z.string(),
  record: z.record(z.unknown()).nullable().optional(),
  originInstanceId: z.string().optional(),
  ts: z.string()
});

// Brain sync push schema (POST /api/brain/sync body)
export const brainSyncPushSchema = z.object({
  changes: z.array(brainSyncChangeSchema).min(1).max(1000)
});

// Brain parity check body (POST /api/brain/reconcile/parity). `peerId` is the
// LOCAL peer-registry id (the same id `/api/instances/peers/:id/sync` takes, so
// the Instances card can pass the peer it already holds). Omitted runs the sweep
// across every federating peer.
export const brainParityCheckSchema = z.object({
  peerId: z.string().min(1).max(200).optional()
});

// Brain bridge-sync body (POST /api/brain/bridge-sync). `refresh` forces a
// re-embed of already-mapped records — the recovery path for memory entries
// that diverged before the per-record sync:applied signal existed (issue
// #1080). `onlyMissing` is the cheap targeted backfill: embed just the records
// that lack an embedding (unmapped, or mapped to a NULL-embedding memory) and
// skip everything healthy. Both optional + default-false so the existing
// no-body call is unchanged.
export const brainBridgeSyncSchema = z.object({
  refresh: z.boolean().optional().default(false),
  onlyMissing: z.boolean().optional().default(false)
});

// Brain graph query (GET /api/brain/graph?focus=<id>&limit=<n>). No `focus`
// returns the bounded overview; a `focus` returns that node's neighborhood.
export const brainGraphQuerySchema = z.object({
  focus: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(250).optional()
});

// Daily log settings schema (PUT /api/brain/daily-log/settings body).
// Only these three keys are persisted — strict() rejects unknown keys so
// a typo or stray payload field can't corrupt the settings file.
export const dailyLogSettingsSchema = z.object({
  obsidianVaultId: z.string().nullable().optional(),
  obsidianFolder: z.string().optional(),
  autoSync: z.boolean().optional()
}).strict();

// Activity-digest (daily-log auto-drafts, #2155) settings. Managed fields
// (lastRunDate/lastRunAt) are server-owned and intentionally NOT accepted here —
// the service strips anything but these client-settable keys. Empty-string
// provider/model (UI "None" sentinel) coerces to null so the non-LLM path runs.
const emptyToNull = (v) => (v === '' ? null : v);
export const activityDigestSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.preprocess(emptyToNull, z.string().nullable().optional()),
  model: z.preprocess(emptyToNull, z.string().nullable().optional()),
  runTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM (24h)').optional(),
  catchUpDays: z.number().int().min(0).max(30).optional()
}).strict();

// POST /api/brain/{digest,review}/run — manual trigger with optional provider /
// model overrides (both absent = use configured defaults).
export const brainDigestRunSchema = z.object({
  providerOverride: z.string().optional(),
  modelOverride: z.string().optional()
});

// =============================================================================
// SONGBOOK SCHEMAS (Brain entity type `songs` — guitar tabs / chord sheets)
// =============================================================================

// Learning stage for a repertoire song
export const songStageEnum = z.enum(['new', 'learning', 'learned', 'memorized']);

// Instrument the sheet is written for. ADDITIVE only — brain records sync raw
// (LWW, no Zod re-validation on receive), so an older peer already stores an
// unknown instrument fine; removing a value would 400 an edit of a synced song.
export const songInstrumentEnum = z.enum(['guitar', 'piano', 'ukulele', 'bass', 'voice', 'drums', 'other']);

// Content notation format (drives the client-side parser/renderer). `drum` is
// the kit-grid DSL parsed by client/src/lib/drumNotation.js and drawn by
// <DrumSheetView> — everything else goes through tabNotation/<TabSheetView>.
export const songContentFormatEnum = z.enum(['chordpro', 'tab', 'plain', 'drum']);

// The SHAPES the write endpoints accept for those two fields — the enum above,
// OR any other short slug. Deliberately wider than the enum, because brain songs
// sync raw between installs on independent upgrade schedules (LWW, no Zod on
// receive): a peer running a newer version can hand this install an instrument or
// format it has never heard of, and that value is already sitting in the record.
// If a write then rejected it, the user could not edit that song AT ALL — every
// save would 400 on a field they never touched — and the client's own
// "keep an unknown stored value in the select" behavior (see
// `withStoredOption` in client/src/components/songbook/constants.js) would be
// unable to round-trip what it preserved.
//
// The enum stays the source of truth for what the UI OFFERS and what the client
// mirrors; this is only the acceptance boundary. The slug pattern keeps it from
// becoming a free-text field: lowercase alphanumerics plus `-`/`_`, ≤32 chars,
// which is what every value either side has ever used.
const songForwardCompatSlug = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);
const songInstrumentValue = z.union([songInstrumentEnum, songForwardCompatSlug]);
const songContentFormatValue = z.union([songContentFormatEnum, songForwardCompatSlug]);

// Cross-links from a song to the OTHER music record kinds in PortOS (#4103):
// a Round (`/rounds/:id`) or a generated/imported music Track
// (`/music/tracks/:id`). MIDI is deliberately absent — there is no MIDI record
// in PortOS; MIDI is a file (already a songbook attachment, see
// SONGBOOK_ATTACHMENT_EXTENSIONS) or `referenceAudio.midiFilename` on a Round,
// which the `round` link already reaches.
export const songLinkTypeEnum = z.enum(['round', 'track']);

// Same enum-OR-slug acceptance boundary as instrument/format above, for the
// same reason: brain records sync raw (LWW, no Zod on receive), so a song
// arriving from a NEWER peer can carry a link type this install has never heard
// of. Rejecting it would make that song uneditable — every save 400ing on a
// field the user never touched.
const songLinkTypeValue = z.union([songLinkTypeEnum, songForwardCompatSlug]);

// One cross-link. `label` is the target's title DENORMALIZED at link time:
// Rounds and Tracks are not brain records and do not necessarily exist on every
// federated machine, so a link that resolves to nothing locally still renders a
// name instead of a bare id.
const songLinkSchema = z.object({
  type: songLinkTypeValue,
  id: z.string().trim().min(1).max(200),
  label: z.string().trim().max(300).optional().default(''),
});

// Nested content object — named so the update schema below can rebuild it
// defaults-free (partialWithoutDefaults only strips TOP-LEVEL field defaults).
const songContentSchema = z.object({
  format: songContentFormatValue.optional().default('tab'),
  text: z.string().max(200000).optional().default('')
});

// Create/Update Song input schema. Attachment metadata ({ filename, label,
// mime, size, sha256 }) is server-managed — synced in the record, mutated only
// by the attachment endpoints, never client-suppliable (no schema key here, so
// Zod's unknown-key stripping drops it).
export const songInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  artist: z.string().trim().max(300).optional().default(''),
  instrument: songInstrumentValue.optional().default('guitar'),
  stage: songStageEnum.optional().default('new'),
  tags: z.array(z.string().trim().min(1).max(50)).max(50).optional().default([]),
  key: z.string().trim().max(20).optional().default(''),
  capo: z.number().int().min(0).max(12).optional().default(0),
  tuning: z.string().trim().max(40).optional().default(''),
  sourceUrl: z.string().trim().max(2000).optional().default(''),
  // Cross-links to Rounds / music Tracks (#4103). On a PATCH the top-level
  // default is stripped, so an OMITTED key preserves the stored links while an
  // explicit `[]` clears them (the absent-vs-empty rule).
  links: z.array(songLinkSchema).max(20).optional().default([]),
  content: songContentSchema.optional().default({ format: 'tab', text: '' }),
  notes: z.string().max(5000).optional().default(''),
  // "Fit to duration" autoscroll target: how many seconds the play view should
  // take to scroll the sheet top-to-bottom. Stored per song and federated with
  // the record; the px/s it implies is derived CLIENT-side at click time from
  // the rendered scroll height (which depends on font size, transpose, and the
  // viewport), so nothing server-side reads this — the bounds only keep it sane
  // (15s … 1h).
  //
  // `null` is the explicit "no target set" value, and it must stay reachable on
  // a PATCH: songUpdateSchema strips the default, so an OMITTED key preserves
  // the stored target while an explicit `null` clears it (the absent-vs-empty
  // rule). A create with no target lands as null rather than undefined so the
  // field exists in the synced record.
  scrollDurationSec: z.number().int().min(15).max(3600).nullable().optional().default(null)
});

// PATCH /api/brain/songbook/:id — defaults-free partial. partialWithoutDefaults
// only strips top-level defaults (see the zodCompat docstring): a
// present-but-partial `content` object would still inflate its inner defaults
// — `{ content: { text } }` resetting format to 'tab', `{ content: { format } }`
// wiping the whole text (and the wipe federates). The nested content field is
// rebuilt defaults-free too; the route deep-merges `data.content` over the
// stored song's content so an omitted inner key preserves the stored value.
export const songUpdateSchema = partialWithoutDefaults(songInputSchema).extend({
  content: partialWithoutDefaults(songContentSchema).optional()
});

// POST /api/brain/songbook/:id/practice — log one practice run (#4102).
//
// `quality` is the SM-2 self-grade for the run: 0 = couldn't play it, 5 = clean.
// It is the ONLY input; the resulting schedule and stage are computed
// server-side from the stored record (see lib/songPractice.js), because an
// SM-2 advance needs the previous schedule and a client-computed one would both
// race and put the scheduler in the browser.
//
// The `practice` object itself is deliberately absent from songInputSchema /
// songUpdateSchema: like `attachments`, it is server-managed, so Zod's
// unknown-key stripping drops a client-supplied value and only this endpoint
// can move it.
// The ceiling reads from lib/spacedRepetition.js rather than restating `5`, so
// the accepted grade range can never drift from the scale the scheduler grades on.
export const songPracticeInputSchema = z.object({
  quality: z.number().int().min(0).max(MAX_QUALITY)
});

// POST /api/brain/songbook/import/url
export const songImportUrlSchema = z.object({
  url: z.string().url().max(2000)
});

// POST /api/brain/songbook/:id/attachments — base64 upload body
export const songAttachmentUploadSchema = z.object({
  filename: z.string().min(1).max(300),
  data: z.string().min(1),
  label: z.string().max(300).optional().default('')
});

// =============================================================================
// YOUTUBE INGEST SCHEMAS (POST /api/brain/youtube/*)
// =============================================================================

// POST /api/brain/youtube/ingest. The URL host/shape allowlist lives in the
// service (assertYoutubeIngestUrl) so the error names the supported URL forms;
// the schema guards the payload shape and the bounds.
//
// The three capture switches are independently optional — the service rejects
// an all-false request with NOTHING_TO_INGEST rather than silently doing work
// the user didn't ask for. `agentPrompt` is what turns an ingest into a queued
// CoS task; absent/empty means "just store it".
export const youtubeIngestSchema = z.object({
  url: z.string().url().max(2048),
  captureTranscript: z.boolean().optional(),
  downloadVideo: z.boolean().optional(),
  ingestAudio: z.boolean().optional(),
  agentPrompt: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(60)).max(20).optional(),
  priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional()
});

// PUT /api/brain/youtube/settings. strict() rejects unknown keys so a typo
// can't quietly accumulate in the settings file.
export const youtubeIngestSettingsSchema = z.object({
  obsidianVaultId: z.string().nullable().optional(),
  obsidianFolder: z.string().max(300).optional(),
  autoSync: z.boolean().optional(),
  defaultCaptureTranscript: z.boolean().optional(),
  defaultDownloadVideo: z.boolean().optional(),
  defaultIngestAudio: z.boolean().optional(),
  taskPriority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional()
}).strict();
