/**
 * Leaf module of cross-domain Zod fragments shared by the per-domain `*Validation.js` files
 * without circular imports.
 */

import { z } from 'zod';
import { MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS } from './imageLimits.js';
import { SERIES_DESIGN_MODES, SERIES_DESIGN_TEXT_MAX, SERIES_DESIGN_FIELDS } from './storyArcLimits.js';

import { RENDER_TARGET_BACKEND_AUTO, RECORD_RENDER_MODEL_MAX } from './renderTargets.js';
import { QUEUEABLE_IMAGE_MODES } from './generationModes.js';
import { GROK_VIDEO_DURATIONS } from './grokVideoClip.js';
import { PM2_PROCESS_NAME_MAX, PM2_PROCESS_NAME_RE } from '../../lib/pm2ProcessName.js';
import { providerRefSchema } from './zodCompat.js';

/**
 * Cross-domain Zod primitives: fragments more than one validation domain needs. Lives in a leaf module, for the same TDZ-cycle reason as `zodCompat.js`: a domain validation file never imports another one, so a schema two domains need (including the file-private helpers they share, such as `nonEmptyString`) is declared here and imported by both.
 * `zodCompat.js` holds Zod-version compatibility helpers; this holds PortOS-domain vocabulary (render pins, model-id charset, clip lengths, path safety).
 */

// Optional author-owned story intent, shared by Pipeline and other story consumers.
export const seriesDesignSchema = z.object({
  mode: z.enum(SERIES_DESIGN_MODES),
  ...Object.fromEntries(Object.keys(SERIES_DESIGN_FIELDS).map((field) => [field, z.string().trim().max(SERIES_DESIGN_TEXT_MAX).optional()])),
});
// Clip lengths grok's image_to_video delivers, as a union from the shared list (grokVideoClip.js). `z.literal` per value keeps the "expected 6 | 10" message; shared by routes/videoGen.js and the sprite animation schemas.
export const grokVideoDurationSchema = z.union(
  GROK_VIDEO_DURATIONS.map((d) => z.literal(d)),
);

// Shared "valid model id" base (bounds + charset) for cloud-CLI model ids, derived per consumer so a tweak lands everywhere (settings schemas, universe render override, sprite pins).
export const cloudModelIdString = (message) => z.string().trim().max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, message);

// Per-RECORD render pin (#3231): the flat `imageMode`/`imageModelId` pair on universe/series/sprite records, spread into create + patch schemas. Absent preserves; `'auto'`/`''`/null clears
// (sanitizers collapse all three to "no pin"). The model id keeps the cloud-model charset so a pinned id can safely reach a CLI argv.
export const recordRenderPinFields = {
  imageMode: z.preprocess(
    (v) => (v === '' ? null : v),
    z.enum([RENDER_TARGET_BACKEND_AUTO, ...QUEUEABLE_IMAGE_MODES]).nullable().optional(),
  ),
  imageModelId: z.preprocess(
    (v) => (v === '' ? null : v),
    cloudModelIdString('model must be a valid model id').max(RECORD_RENDER_MODEL_MAX).nullable().optional(),
  ),
};

// Batch-by-id query param (`?ids=a,b,c`, #4148). A CSV string and the repeated `?ids=a&ids=b` form (members may be CSV) normalize identically: entries trimmed, blanks dropped,
// and an empty/all-blank value collapses to `undefined` so the route falls through to its normal filters.
// `truncate: false` (default) rejects an over-cap batch with 400 (a silent partial result is indistinguishable from "ids don't exist"); `true` slices at `max`, the catalog ingredient
// list's established contract.
export const csvIdsParam = ({ max, maxIdLength = 64, truncate = false } = {}) => z.preprocess((v) => {
  if (typeof v !== 'string' && !Array.isArray(v)) return v;
  const parts = (Array.isArray(v) ? v : [v])
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [entry]))
    .map((s) => (typeof s === 'string' ? s.trim() : s))
    .filter((s) => s !== '');
  const bounded = truncate ? parts.slice(0, max) : parts;
  return bounded.length ? bounded : undefined;
}, z.array(z.string().trim().min(1).max(maxIdLength)).max(max).optional());

// subdirFilter is interpolated into an rsync `--include=${subdirFilter}/***` arg (shell:false, so not shell injection, but `*` would defeat the filter chain and `../foo` would escape the
// snapshot subdir). Restrict to a relative path of safe characters: no wildcard, traversal, absolute, or empty/`.` segment (`brain/`, `./brain`, `a//b` spell one path differently).
// Exported as a predicate so the restoreSnapshot guard and sprite run-id schemas reuse it (mirrors isSafeRecordId in zodCompat.js; #1822).
export const isSafeSubdirFilter = (v) =>
  typeof v === 'string'
  && /^[a-z0-9._/-]+$/i.test(v)
  && !v.split('/').some(part => part === '' || part === '.' || part === '..');

// Backup sources are directory names under snapshots/. `@legacy` is reserved for the pre-namespace root; `@` can't occur in sanitized machine names, so a machine named "legacy" stays addressable.
export const isSafeSnapshotSource = (v) =>
  typeof v === 'string'
  && v.length > 0
  && v.length <= 255
  && (v === '@legacy' || (v !== '.' && v !== '..' && /^[a-z0-9._-]+$/i.test(v)));

// ---------------------------------------------------------------------------
// Backup exclude patterns (#7241)
//
// The exclude list is rsync FILTER syntax: a pattern is anchored to the transfer root only when it starts with `/`; anything else matches at EVERY level, so `cache/` also drops
// nested per-run caches and the snapshot still reports success (the omission surfaces only at restore). `DEFAULT_EXCLUDES` is anchored by hand (tested in `backup.snapshots.test.js`);
// this applies the same rule to the user-edited list. It lives beside `isSafeSubdirFilter` because `backupConfigSchema` and `computeEffectiveExcludes` (services/backup.js) must share ONE
// rule from a leaf both already import (lib/importScoping.test.js). Anchoring happens at READ time; stored settings stay as typed, so nothing to migrate.
// Mirrored to `client/src/lib/backupExcludes.js`.
// ---------------------------------------------------------------------------

/** Longest exclude pattern, measured on the ANCHORED form handed to rsync (bounding the raw input would accept 256 chars that anchor to 257). */
export const EXCLUDE_PATTERN_MAX_LENGTH = 256;

/** Already anchored (`/…`) or deliberately any-depth (`*…`, which covers `**`) patterns are left alone; everything else gets a leading `/`. */
const isAnchoredOrWildcardLed = (pattern) => pattern.startsWith('/') || pattern.startsWith('*');

/**
 * Normalize ONE user-entered pattern to what rsync is handed: the single declaration of a legal pattern (`isSafeExcludePattern` is defined in terms of it, so the settings
 * boundary can never accept what the read-time normalizer would drop).
 *
 * @param {unknown} pattern
 * @returns {string|null} the anchored pattern, or null when it is blank,
 *   non-string, or unsafe (caller drops it).
 */
export function anchorUserExclude(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  // A NUL would truncate the rsync argument; `..` in any segment walks out of the data root.
  if (!trimmed || trimmed.includes('\0')) return null;
  if (trimmed.split('/').includes('..')) return null;
  const anchored = isAnchoredOrWildcardLed(trimmed) ? trimmed : `/${trimmed}`;
  return anchored.length <= EXCLUDE_PATTERN_MAX_LENGTH ? anchored : null;
}

/** Whether a pattern survives normalization; shared with `lib/backupValidation.js` so the settings boundary rejects exactly what `computeEffectiveExcludes` would drop.
 * @param {unknown} pattern
 * @returns {boolean}
 */
export const isSafeExcludePattern = (pattern) => anchorUserExclude(pattern) !== null;

/**
 * Normalize a whole user list, dropping blank/unsafe entries and duplicates that differ only by anchoring or whitespace.
 *
 * @param {unknown} patterns
 */
export function anchorUserExcludes(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  return [...new Set(list.map(anchorUserExclude).filter(Boolean))];
}

// ── Automatic PortOS self-update (Update tab) ───────────────────────────────
//
// The EFFECTIVE config, resolved from the sparse `settings.autoUpdate` slice (the store keeps only what the user set, e.g. `{ enabled: true }`). One resolver is read by
// `autoUpdateSettingsSchema`, `services/autoUpdateScheduler.js` and the settings GET projection so an omitted field can't mean different things in each (#6632).

/**
 * Which update action the scheduler performs, each EXACTLY the action a button performs via the same service:
 *   - `release`: the Update page's "Update Now" (`startPortosSelfUpdate`, gated on a newer release tag).
 *   - `main`: App Management's "Update app" for the PortOS record (`runAppUpdate`), gated on origin being ahead so it doesn't reinstall the same revision every interval.
 */
export const AUTO_UPDATE_CHANNELS = ['release', 'main'];
export const DEFAULT_AUTO_UPDATE_CHANNEL = 'release';
/** Hours to wait after the last update before starting to look for a window. */
export const DEFAULT_AUTO_UPDATE_MIN_INTERVAL_HOURS = 6;
export const AUTO_UPDATE_MIN_INTERVAL_HOURS_MIN = 1;
export const AUTO_UPDATE_MIN_INTERVAL_HOURS_MAX = 24 * 30;

/**
 * @param {object} [raw] - the stored `settings.autoUpdate` slice.
 * @returns {{enabled: boolean, channel: 'release'|'main', minIntervalHours: number, minIntervalMs: number, resolveBlockersWithAgent: boolean}}
 */
export function resolveAutoUpdateConfig(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const channel = AUTO_UPDATE_CHANNELS.includes(source.channel) ? source.channel : DEFAULT_AUTO_UPDATE_CHANNEL;
  const requested = Number(source.minIntervalHours);
  const minIntervalHours = Number.isFinite(requested)
    ? Math.min(AUTO_UPDATE_MIN_INTERVAL_HOURS_MAX, Math.max(AUTO_UPDATE_MIN_INTERVAL_HOURS_MIN, requested))
    : DEFAULT_AUTO_UPDATE_MIN_INTERVAL_HOURS;
  return {
    // OFF unless explicitly on: an install upgrading into this code must not start restarting itself.
    enabled: source.enabled === true,
    channel,
    minIntervalHours,
    minIntervalMs: minIntervalHours * 60 * 60 * 1000,
    // Whether a checkout no script can repair (uncommitted work, interrupted rebase) queues a CoS agent. Defaults ON (a silent stuck updater is worse) but is a switch since it costs a provider call.
    resolveBlockersWithAgent: source.resolveBlockersWithAgent !== false,
  };
}

/**
 * The resolved config MINUS the derived `minIntervalMs`, exactly the keys the `.strict()` `autoUpdateSettingsSchema` accepts: surfaces echo the effective config back on the next save,
 * so a derived key would turn every toggle into a 400. Used by the settings GET and `GET /api/update/auto`.
 */
export function storableAutoUpdateConfig(raw) {
  const { minIntervalMs: _derived, ...storable } = resolveAutoUpdateConfig(raw);
  return storable;
}

export const imageEdgeSchema = z.number().int().min(64).max(MAX_IMAGE_EDGE).optional();
export const refineImagePixelCap = (d) =>
  !(d.width && d.height) || d.width * d.height <= MAX_IMAGE_PIXELS;
export const PIXEL_CAP_MESSAGE = `Total pixels (width × height) must be ≤ ${MAX_IMAGE_PIXELS.toLocaleString()}`;

// Reject option-shaped names before PM2 interprets positional arguments.
export const pm2ProcessNameSchema = z.string().min(1).max(PM2_PROCESS_NAME_MAX)
  .regex(PM2_PROCESS_NAME_RE, 'Must start with an alphanumeric character or underscore');

export const logsQuerySchema = z.object({
  lines: z.coerce.number().int().min(1).max(5000).default(100),
  follow: z.enum(['true', 'false']).optional(),
});

// A service account JSON key is ~2.4 KB; leave room for a long one.
export const GOOGLE_CREDENTIAL_MAX_LENGTH = 16_000;

// Per-request LLM provider/model override. Shared by universe-builder expand
// routes and pipeline arc-planning routes. Optional so callers that omit the
// llm field fall back to the server's active provider.
export const llmSchema = z.object({
  provider: providerRefSchema.nullable().optional(),
  model: z.string().trim().max(200).nullable().optional(),
}).optional();

export const nonEmptyString = z.string().min(1);
export const optionalString = z.string().optional();
export const nullishString = z.string().nullish();

// A file name on the media static mounts: no path separators, no traversal.
export const mediaFilenameSchema = z.string().min(1).max(255).refine((v) => !/[\\/]/.test(v) && v !== '.' && v !== '..', 'Invalid file name');
