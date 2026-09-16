import { z } from 'zod';
import { SERIES_DESIGN_MODES, SERIES_DESIGN_TEXT_MAX, SERIES_DESIGN_FIELDS } from './storyArcLimits.js';

import { RENDER_TARGET_BACKEND_AUTO, RECORD_RENDER_MODEL_MAX } from './renderTargets.js';
import { QUEUEABLE_IMAGE_MODES } from './generationModes.js';
import { GROK_VIDEO_DURATIONS } from './grokVideoClip.js';

/**
 * Cross-domain Zod primitives — the schema fragments that more than one
 * validation domain needs.
 *
 * Lives here (a leaf module) rather than in `validation.js` for the same
 * TDZ-cycle reason `zodCompat.js` exists: `validation.js` re-exports every
 * per-domain `*Validation.js` file with `export * from`, and ESM hoists those
 * re-exports above the module body — so a domain file that imported a value
 * back from `validation.js` would read it before it was initialized. Anything
 * both `validation.js` and a domain file need has to sit below both.
 *
 * `zodCompat.js` holds the *Zod-version* compatibility helpers (`.partial()`
 * semantics, empty-string sentinels); this module holds *PortOS-domain*
 * fragments that carry real business vocabulary (render pins, model-id
 * charset, clip lengths, path safety). Keeping them apart is what stops
 * zodCompat from accumulating imports on renderTargets/imageGen/grok modules.
 */

// Optional author-owned story intent, shared by Pipeline and other story consumers.
export const seriesDesignSchema = z.object({
  mode: z.enum(SERIES_DESIGN_MODES),
  ...Object.fromEntries(Object.keys(SERIES_DESIGN_FIELDS).map((field) => [field, z.string().trim().max(SERIES_DESIGN_TEXT_MAX).optional()])),
});
// Clip lengths grok's image_to_video delivers, as a Zod union built from the
// single shared list (see grokVideoClip.js). `z.literal` per value rather than
// `z.number().refine()` keeps the "expected 6 | 10" error message the
// hand-written union produced. Shared so routes/videoGen.js and the sprite
// animation schemas validate `duration` against this same union instead of
// rebuilding it.
export const grokVideoDurationSchema = z.union(
  GROK_VIDEO_DURATIONS.map((d) => z.literal(d)),
);

// Shared "valid model id" base — one definition of the shape a cloud-CLI
// model id may take (bounds + charset), derived per consumer so a future
// tweak (e.g. allowing `@`) lands everywhere at once. Used by settings
// schemas, the universe render route's one-off override, and the sprite
// fork/render pins.
export const cloudModelIdString = (message) => z.string().trim().max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/, message);

// Per-RECORD render pin (#3231 Phase 3) — the flat `imageMode`/`imageModelId`
// field pair persisted on universe / series / sprite records, following the
// creative-commission shape. Spread into a record's create + patch schemas.
// Absent preserves; `'auto'`/`''`/null clears (the sanitizers collapse all
// three to "no pin"). The model id keeps the shared cloud-model charset so a
// pinned id can safely reach a CLI argv.
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

// Batch-by-id query param — `?ids=a,b,c` on a list route (#4148). Both wire
// forms normalize identically: a CSV string, and the repeated `?ids=a&ids=b`
// form Express hands over as an array (whose members may themselves be CSV).
// Each entry is trimmed and blanks are dropped, so one shape can't slip past the
// blank-removal or the cap the other enforces. An empty/all-blank value
// collapses to `undefined` so the field reads cleanly as absent
// (sentinel-not-empty) and the route falls through to its normal filters.
//
// `truncate` picks what an over-cap batch does. `false` (the default) rejects it
// with a 400 — the caller learns its request was too big instead of receiving a
// partial result it can't distinguish from "those ids don't exist". `true`
// silently slices at `max`, which the catalog's ingredient list has done since
// it shipped; kept as an option so this shared helper doesn't change that
// route's established contract.
export const csvIdsParam = ({ max, maxIdLength = 64, truncate = false } = {}) => z.preprocess((v) => {
  if (typeof v !== 'string' && !Array.isArray(v)) return v;
  const parts = (Array.isArray(v) ? v : [v])
    .flatMap((entry) => (typeof entry === 'string' ? entry.split(',') : [entry]))
    .map((s) => (typeof s === 'string' ? s.trim() : s))
    .filter((s) => s !== '');
  const bounded = truncate ? parts.slice(0, max) : parts;
  return bounded.length ? bounded : undefined;
}, z.array(z.string().trim().min(1).max(maxIdLength)).max(max).optional());

// subdirFilter is interpolated into an rsync `--include=${subdirFilter}/***`
// arg (rsync runs shell:false, so this is not shell injection — but `*` would
// expand to `--include=*/***` and defeat the filter chain, and `../foo` would
// traverse out of the snapshot subdir). Restrict to a relative path of safe
// characters with no wildcard, traversal, or absolute segments. Exported as a
// predicate so the restoreSnapshot service guard and the sprite run-id schemas
// reuse the exact same rule (mirrors isSafeRecordId in validation.js) — see
// issue #1822.
export const isSafeSubdirFilter = (v) =>
  typeof v === 'string'
  && /^[a-z0-9._/-]+$/i.test(v)
  && !v.split('/').includes('..')
  && !v.startsWith('/');

// Backup sources are directory names under snapshots/. `@legacy` is reserved
// for the pre-namespace snapshots root; `@` cannot occur in the sanitized
// machine names used by backup.js, so a real machine named "legacy" stays
// independently addressable.
export const isSafeSnapshotSource = (v) =>
  typeof v === 'string'
  && v.length > 0
  && v.length <= 255
  && (v === '@legacy' || (v !== '.' && v !== '..' && /^[a-z0-9._-]+$/i.test(v)));

// ---------------------------------------------------------------------------
// Backup exclude patterns (#7241)
//
// The backup exclude list is rsync FILTER syntax, not a glob list. rsync anchors
// a pattern to the transfer root only when it starts with `/`; anything else
// matches at EVERY level of the tree. So a user who types `cache/` to skip
// `data/cache/` also drops the per-run caches nested under training runs, and
// `raw/` reaches into sprite runs and universes. The snapshot still reports
// success — the omission surfaces only at restore, which is exactly when it
// cannot be fixed.
//
// `DEFAULT_EXCLUDES` has always been anchored by hand (and a test in
// `backup.test.js` fails if one entry is not); this is the same rule applied to
// the one list a user actually edits. Lives here, beside `isSafeSubdirFilter`
// and for the same reason: `backupConfigSchema` in `validation.js` and the
// `computeEffectiveExcludes` guard in `services/backup.js` must share ONE rule,
// and both modules already import this leaf — so declaring it here costs the
// server suite no extra module instantiations (see lib/importScoping.test.js).
// Anchoring happens at READ time, never by rewriting stored settings: the stored
// value stays exactly what the user typed, so there is nothing to migrate.
// Mirrored to `client/src/lib/backupExcludes.js` for the Backup settings tab.
// ---------------------------------------------------------------------------

/**
 * Longest exclude pattern accepted, measured on the ANCHORED form — the string
 * actually handed to rsync. Bounding the raw input instead would let a
 * 256-character relative pattern pass validation and then anchor to 257, so the
 * settings boundary would reject the very chip the UI had just shown as valid.
 */
export const EXCLUDE_PATTERN_MAX_LENGTH = 256;

/**
 * A pattern is left alone when it is already anchored (`/…`) or deliberately
 * any-depth (`*…`, which covers rsync's `**` spelling). Everything else gets a
 * leading `/`.
 */
const isAnchoredOrWildcardLed = (pattern) => pattern.startsWith('/') || pattern.startsWith('*');

/**
 * Normalize ONE user-entered pattern to the form rsync will be handed. This is
 * the single declaration of what a legal pattern is — `isSafeExcludePattern`
 * below is defined in terms of it, so the settings boundary can never accept
 * something the read-time normalizer would then drop, or vice versa.
 * @param {unknown} pattern
 * @returns {string|null} the anchored pattern, or null when it is blank,
 *   non-string, or unsafe (caller drops it).
 */
export function anchorUserExclude(pattern) {
  if (typeof pattern !== 'string') return null;
  const trimmed = pattern.trim();
  // A NUL would truncate the rsync argument; `..` in any segment (`../x`,
  // `a/../../x`, the bare `..`) walks out of the data root.
  if (!trimmed || trimmed.includes('\0')) return null;
  if (trimmed.split('/').includes('..')) return null;
  const anchored = isAnchoredOrWildcardLed(trimmed) ? trimmed : `/${trimmed}`;
  return anchored.length <= EXCLUDE_PATTERN_MAX_LENGTH ? anchored : null;
}

/**
 * Whether a stored/submitted pattern survives normalization. Shared with
 * `lib/validation.js` so the settings boundary rejects exactly what
 * `computeEffectiveExcludes` would have dropped.
 * @param {unknown} pattern
 * @returns {boolean}
 */
export const isSafeExcludePattern = (pattern) => anchorUserExclude(pattern) !== null;

/**
 * Normalize a whole user list, dropping blank/unsafe entries and duplicates
 * that only differed by anchoring or whitespace.
 * @param {unknown} patterns
 * @returns {string[]}
 */
export function anchorUserExcludes(patterns) {
  const list = Array.isArray(patterns) ? patterns : [];
  return [...new Set(list.map(anchorUserExclude).filter(Boolean))];
}

// ── Automatic PortOS self-update (Update tab) ───────────────────────────────
//
// The EFFECTIVE configuration, resolved from the sparse `settings.autoUpdate`
// slice. Sparse because the settings store keeps what the user actually set: an
// install that only ever ticked the checkbox stores `{ enabled: true }`, and
// every reader has to agree on what the omitted fields mean. One resolver, read
// by `autoUpdateSettingsSchema` at the PUT boundary, by
// `services/autoUpdateScheduler.js`, and by the settings GET projection — so an
// omitted `channel` can never mean `release` in one and `main` in another. Same
// rule, and the same home, as the backup-exclude anchoring above (#6632 is the
// lesson from getting it wrong for the backup schedule).

/**
 * Which update action the scheduler performs. Each is EXACTLY the action a
 * button already performs, dispatched through the same service:
 *
 *   - `release` — the Update page's "Update Now": `startPortosSelfUpdate` in
 *     `release` mode, gated on a newer GitHub release tag.
 *   - `main`    — App Management's Git tab "Update app" for the PortOS record:
 *     `runAppUpdate`, which advances the checkout onto origin's default branch
 *     and then runs the same update script. Gated on origin actually being
 *     ahead, so it does not reinstall the same revision every interval.
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
    // OFF unless explicitly on. An install that has never seen this feature must
    // not start restarting itself because it upgraded into the code.
    enabled: source.enabled === true,
    channel,
    minIntervalHours,
    minIntervalMs: minIntervalHours * 60 * 60 * 1000,
    // Whether a checkout that no script may safely repair (uncommitted work, an
    // interrupted rebase) queues a CoS agent to resolve it. Defaults ON because
    // an unattended updater that silently stops forever is worse than one that
    // asks for help — but it is a switch, since that help costs a provider call.
    resolveBlockersWithAgent: source.resolveBlockersWithAgent !== false,
  };
}

/**
 * The resolved config MINUS the derived `minIntervalMs`, i.e. exactly the keys
 * `autoUpdateSettingsSchema` accepts.
 *
 * Every surface that shows the effective config also hands it back on the next
 * save (the panel PUTs `{...draft, ...patch}`), and the schema is `.strict()` —
 * so echoing a derived key turns every toggle into a 400. One projection, used
 * by both the settings GET and `GET /api/update/auto`, is what keeps the two
 * from having to remember that separately.
 */
export function storableAutoUpdateConfig(raw) {
  const { minIntervalMs: _derived, ...storable } = resolveAutoUpdateConfig(raw);
  return storable;
}
