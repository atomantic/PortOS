/**
 * Backup exclude policy: the default rsync excludes, the effective-exclude
 * merge, and the restore-side OS-metadata, preserved-file and instance-identity
 * path rules. Pure path policy with no I/O.
 */

import { anchorUserExcludes } from '../../lib/sharedSchemas.js';

// Paths under data/ that are skipped by default on top of user-configured excludes.
// Two classes live here: (1) ephemeral/cache data the user almost never wants in a
// snapshot (browser profile, agent worktrees), and (2) large re-downloadable assets
// (LoRA model files, cloned repos, browser downloads) that would bloat the backup
// target — typically iCloud or an external drive with limited capacity. Entries
// tagged `overridable: true` can be re-enabled from the Backup settings UI via
// `disabledDefaultExcludes`; non-overridable entries hold no irreplaceable user data
// and stay off unconditionally. When adding a new entry, ensure the path glob covers
// *every* on-disk location for that class of data — e.g. agent worktrees live under
// both cos/worktrees/ and cos/feature-agents/*/worktree/; cross-reference
// worktreeManager.js and agentLifecycle.js if introducing new worktree paths.
//
// All paths are anchored with a leading `/` (rsync filter syntax for "relative to
// the transfer root"). Without the anchor, a pattern like `loras/*.safetensors`
// matches any `loras/` directory anywhere under data/ (e.g. a user's
// brain/.../loras/ collection), which would silently exclude unrelated user data.
export const DEFAULT_EXCLUDES = [
  { path: '/images/.media-copy-*.tmp', reason: 'Unpublished collection media transfer bytes', overridable: false },
  { path: '/videos/.media-copy-*.tmp', reason: 'Unpublished collection media transfer bytes', overridable: false },
  { path: '/videos/.topaz-staging/', reason: 'Ephemeral Topaz upload and result staging', overridable: false },
  { path: '/backup-admission/', reason: 'Machine-local publication ownership and snapshot fences', overridable: false },
  { path: '/image-thumbnails/', reason: 'Regenerable image grid previews', overridable: false },
  { path: '/python/laya-mlx/', reason: 'Rebuildable Laya-MLX experiment runtime and pinned model weights', overridable: false },
  { path: '/browser-profile/', reason: 'Browser CDP profile — cache/cookies, can be several GB', overridable: false },
  { path: '/cos/agents/.branch-policy-revision*', reason: 'Machine-local archive policy index revision', overridable: false },
  { path: '/cos/worktrees/', reason: 'Ephemeral agent git worktrees — recreated on demand', overridable: false },
  { path: '/cos/initialized-checkout-fixtures/', reason: 'Retired CoS checkout test fixtures — regenerable, removed by migration 461', overridable: false },
  { path: '/autofixer/worktrees/', reason: 'Disposable Autofixer repair worktrees — recreated for each repair', overridable: false },
  { path: '/cos/slashdo-resolved/', reason: 'Resolved slashdo command bodies and claim-prompt sections staged for agent prompts — derived from shipped code, regenerated on demand', overridable: false },
  { path: '/cos/feature-agents/*/worktree/', reason: 'Per-feature-agent git worktrees — recreated on demand', overridable: false },
  // `**` (not `*`) so both engines' checkpoint dirs match: the torch trainer
  // writes training-runs/<id>/checkpoints/, mflux writes
  // training-runs/<id>/mflux/checkpoints/.
  { path: '/training-runs/**/checkpoints/', reason: 'LoRA training checkpoints — large intermediate adapter state, resumable-but-regenerable. Deployed adapters in data/loras/, including promoted checkpoints, ARE backed up along with run samples + configs.', overridable: true },
  { path: '/training-runs/*/cache/', reason: 'Precomputed latent/text-embedding training cache — regenerated from the dataset on the next run', overridable: false },
  { path: '/training-runs/*/data/.mflux_cache/', reason: 'mflux low_ram disk-backed encode cache (written inside the staged training data dir) — regenerable', overridable: false },
  { path: '/repos/', reason: 'Cloned git repositories — large, re-cloneable from origin', overridable: true },
  { path: '/cos/reference-repos/', reason: 'Reference upstream repos used by agents — re-cloneable', overridable: true },
  { path: '/browser-downloads/', reason: 'Browser downloads cache — large, re-downloadable', overridable: true },
  { path: '/composition-proofs/', reason: 'HTML-composition contact-sheet proofs — review stills, re-rendered from the composition source', overridable: true },
  { path: '/greybox-renders/', reason: 'In-flight greybox capture pages — removed when each render ends', overridable: false },
  { path: '/photoreal-workspaces/', reason: 'In-flight Environments photoreal Blender workspaces — removed when each render ends', overridable: false },
  { path: '/photoreal-textures/', reason: 'CC0 photo textures for Photoreal looks — re-downloaded from Poly Haven on the next pick; a missing one renders procedurally', overridable: true },
  { path: '/photoreal-blends/', reason: 'Latest Blender scene per Environment, rebuilt from its greybox by the next Photoreal render', overridable: true },
  { path: '/code-animation-workspaces/', reason: 'In-flight sandboxed Code Animation worker workspaces — removed when each run ends', overridable: false },
  { path: '/code-animation-exports/', reason: 'Code Animation frame-exact export staging — the stored HTML plus render shim, staged once per export', overridable: true },
  { path: '/music-video-compositions/', reason: 'In-flight music-video typography overlay scratch — removed when its render ends and swept at boot', overridable: false },
  { path: '/music-video-film-look/', reason: 'In-flight music-video film look pass (a staged link to the finished render) — removed when the pass ends', overridable: false },
  { path: '/music-video-stats-outro/', reason: 'In-flight music-video outro page (fonts and floor stills) — removed when its render ends and swept at boot', overridable: false },
  { path: '/music-video-segments/', reason: 'Cached music-video shot segments — the final render re-renders any that are missing', overridable: true },
  { path: '/code-animation/films/*/renders/', reason: 'Regenerable standalone film renders; authored src and accepted Media History videos are backed up', overridable: true },
  { path: '/music-video/*/blender/renders/', reason: 'Blender film renders — shot frames and videos, stills, cuts and job logs. Re-rendered from the film source beside them (blender/src/), which IS backed up', overridable: true },
  { path: '/music-video-song-renders/', reason: 'In-flight music-video composition renders (a staged copy of the document plus scene media) — removed when the render ends and swept at boot', overridable: false },
  { path: '/launch-videos/*/*/proofs/', reason: 'Launch-video critique-loop contact sheets — re-rendered from the run composition', overridable: true },
  { path: '/cache/', reason: 'Remote-API metadata and licensed reading caches — regenerable on demand, and stale on restore anyway', overridable: false },
  // Anchored with a leading `/`, like every entry here. The manifest describes
  // which model weights are on THIS machine's disks; restoring it onto another
  // would claim gigabytes of models that machine does not have, and offer delete
  // buttons for them. It is fully re-derivable by a rescan from Models → Status.
  // Anchored, like every entry here. The restore recovery journal (#9725) is an
  // admission fence for THIS machine's in-flight database restore; a restored
  // copy would re-fence the database for an operation that no longer exists.
  { path: '/tailcat-serve.json', reason: 'Machine-local Tailcat capability and device approval authority — never export or restore historical grants', overridable: false },
  { path: '/tailcat-serve.json.*.tmp', reason: 'Interrupted atomic writes of Tailcat capability and approval authority', overridable: false },
  { path: '/tailcat-serve.addr', reason: 'Tailcat capability readiness file — secret transport authority, regenerated by serve', overridable: false },
  { path: '/database-restore-recovery.json', reason: 'In-flight database restore recovery journal — a machine-local admission fence for one restore operation, never data to restore', overridable: false },
  { path: '/.database-restore-recovery-*.pending', reason: 'Unpublished database restore recovery journal bytes — scratch from an interrupted journal write', overridable: false },
  { path: '/model-manifest.json', reason: 'Tracked downloaded-model inventory — machine-local and re-derivable by rescanning the model stores; a restored copy would describe another machine\'s disks', overridable: false },
  // Anchored, like every entry here. Readiness evidence is bound to THIS
  // machine's local image id (a restored copy would read as stale anyway) and
  // the rest is in-flight render scratch; setup re-derives all of it.
  { path: '/supercollider/', reason: 'SuperCollider runtime readiness evidence, in-flight render scratch and 24-hour render previews — machine-local, re-derived by npm run setup:supercollider', overridable: false },
  // Sprite animation-run raw intermediates: 30–96 ffmpeg-extracted PNGs per
  // run, byte-for-byte regenerable from the archived source video by the
  // deterministic postprocess (walkPostprocess.js). The source video, packaged
  // frames, strips, manifests, and runtime atlases ARE backed up. `runs/` is
  // the live (vendor-neutral) layout; `grok/` covers pre-migration-202 runs.
  { path: '/sprites/*/grok/*/generated/raw/', reason: 'Sprite walk-run raw extracted frames — regenerable from the archived source video', overridable: true },
  { path: '/sprites/*/runs/*/generated/raw/', reason: 'Imported sprite-run raw extracted frames — regenerable from the archived source video', overridable: true },
  // Anchored with a leading `/` like every entry here — an unanchored `model.obj`
  // would match at any depth and silently drop unrelated user data.
  //
  // TRELLIS.2's `generate.py` writes this full-resolution OBJ next to the GLB it
  // exports: the decoder's mesh before bake-time decimation, measured at 930 MB /
  // 22.7M faces for one 1024_cascade render. It is regenerable by re-rendering the
  // same source at the same seed, it is not what the 3D page loads (that is
  // model.glb, which IS backed up), and at ~1 GB per render it would otherwise
  // dominate every snapshot. Overridable, because it is the only copy of the
  // discarded detail and someone archiving finished work may want it.
  // Anchored, like every entry here. Capability-test sandboxes are throwaway
  // copies of a fixture that ships in the repo — restoring one would restore a
  // half-finished agent edit, which is worse than not having it.
  { path: '/model-tests/sandboxes/', reason: 'Capability-test agent sandboxes — throwaway working copies of a repo fixture, recreated per run', overridable: false },
  // Anchored, like every entry here. Scratch for ONE in-flight auto-skin run: the
  // worker's staging copy of the rigged GLB plus its job/report files, deleted the
  // moment the run publishes or fails (services/rigging/autoSkin.js). A snapshot that
  // caught it mid-run would restore a half-written mesh next to the published pair.
  // The PUBLISHED rig (rig/<rigId>/) is deliberately NOT excluded: re-deriving it needs
  // a provisioned Blender runtime the restore target may not have, and a rigged GLB is
  // megabytes, not the gigabyte-per-render the model.obj sidecar below costs.
  { path: '/image-to-3d/*/rig/.staging/', reason: 'In-flight auto-skin staging directory — scratch for one rigging run, removed when it publishes or fails. The published rig/<rigId>/ pair IS backed up.', overridable: false },
  // Anchored, like every entry here. Same contract one step later: scratch for ONE
  // in-flight retarget run (services/rigging/retarget.js), including the probe pass's
  // job/report files. The PUBLISHED animation (retarget/<retargetId>/) is NOT excluded,
  // for the same reason the rig is not — re-deriving it needs both a Blender runtime and
  // the clip file the run used.
  { path: '/image-to-3d/*/retarget/.staging/', reason: 'In-flight retarget staging directory — scratch for one retarget run, removed when it publishes or fails. The published retarget/<retargetId>/ pair IS backed up.', overridable: false },
  { path: '/image-to-3d/*/model.obj', reason: 'TRELLIS.2 full-resolution mesh sidecar — ~1 GB per render, regenerable by re-rendering at the same seed. The exported model.glb and keyed source ARE backed up.', overridable: true },
  // Anchored, like every entry here. Not overridable: these are another
  // machine's conditioning bytes, staged for one federated render and swept on
  // a TTL measured in hours. Nothing here is this install's data to keep, and a
  // restored inbox entry is either already expired or already rendered.
  { path: '/federated-media-inbox/', reason: 'Conditioning images an allowlisted peer uploaded for one federated render — TTL-swept, and another machine\'s data rather than this install\'s', overridable: false },
  // Anchored, and not overridable: scratch for in-flight Beeper attachment downloads,
  // written and unlinked outside the backup publication fence (beeperAttachments.js).
  // Stays excluded even when the parent /beeper/attachments/ entry is re-enabled, so a
  // snapshot can never seal a half-written .partial or race an unlink mid-rsync.
  { path: '/beeper/attachments/.tmp/', reason: 'In-flight Beeper attachment download partials — written and removed outside backup publication; published mirrored files under /beeper/attachments/ remain controlled by the overridable parent entry', overridable: false },
  // Anchored, like every entry here. The Beeper attachment mirror (#37) is a
  // lazy CACHE of bytes Beeper Desktop can re-supply, re-fetched on first view
  // and rendered as a labelled reference when it cannot — so a snapshot that
  // skips it loses no record, only a re-download. It is also by far the largest
  // thing the Comms feature puts on disk, which is exactly the kind of
  // directory that turns a nightly snapshot into an hour.
  // Overridable, because an archive of a conversation is more useful with its
  // photos in it, and someone keeping one may well want to pay for them.
  { path: '/beeper/attachments/', reason: 'Beeper attachment byte mirror — a lazy cache re-fetchable from Beeper Desktop; the message bodies and attachment metadata live in Postgres and ARE backed up', overridable: true },
  // Anchored with a leading `/`, like every entry here — an unanchored
  // `corpora/` would match at any depth and silently drop unrelated user data.
  //
  // Two of the three `data/jev/` directories are excluded; `heads/` deliberately
  // is NOT, because a trained head is the one artifact there that does not
  // re-derive. The full three-way tier argument lives in docs/BACKUP.md
  // ("jev project heads — excluded bulk, retained artifact"), which is where a
  // tier change belongs.
  { path: '/jev/corpora/', reason: 'jev training corpora — rebuildable from the forge by scripts/jev-corpus.js. Trained heads in data/jev/heads/ are NOT excluded: a head is not regenerable once its corpus is stale.', overridable: true },
  { path: '/jev/embeddings/', reason: 'Cached frozen-encoder outputs for jev head training — keyed by (pair, model revision) and byte-identical on re-encode', overridable: false }
  // NOTE: legacy file→Postgres migration artifacts (`.imported` / `.bak-NNN`)
  // are intentionally NOT excluded here. They are deleted on disk by the
  // boot-time prune (pruneImportedLegacyFiles.js) the same boot the migration
  // runs — but ONLY once the DB is provably authoritative. While the prune is
  // *blocked* (a wiped/partial-restore DB short of the migration markers) those
  // parked files are the only recovery source, and `pg_dump` is capturing the
  // incomplete DB — so excluding them from snapshots would mean a backup taken
  // in that window restores neither the missing rows nor the source to rebuild
  // them. Letting rsync copy them is the safe default; once the prune removes
  // them from disk they leave subsequent snapshots naturally.
];

// =============================================================================
// EXPORTS
// =============================================================================

/**
 * Compute the effective rsync --exclude list for a backup run. Pure function
 * extracted so the Array.isArray guards + override allow-list can be unit
 * tested without spawning rsync.
 *
 * - Non-overridable defaults stay on regardless of `disabledDefaultExcludes` so
 *   ephemeral/cache paths can never be backed up by mistake (e.g. via a
 *   hand-edited settings.json).
 * - Array.isArray guards: settings can be hand-edited or sent by a stale
 *   client, so a non-array value here would otherwise throw inside .filter
 *   and abort the backup before the defensive allow-list has a chance to apply.
 * - User patterns are ANCHORED here (`anchorUserExcludes`), not in storage: a
 *   bare `cache/` is rsync for "every cache/ at any depth", which silently drops
 *   the per-run caches nested under training runs too. Normalizing on read leaves
 *   the stored value exactly as typed, so there is no migration and nothing is
 *   rewritten under the user. A `*`/`**`-led pattern stays as-is — that is the
 *   deliberate way to ask for any-depth matching.
 */
export function computeEffectiveExcludes({ excludePaths, disabledDefaultExcludes } = {}) {
  const overridablePaths = new Set(DEFAULT_EXCLUDES.filter(e => e.overridable).map(e => e.path));
  const disabledList = Array.isArray(disabledDefaultExcludes) ? disabledDefaultExcludes : [];
  const disabledSet = new Set(disabledList.filter(p => overridablePaths.has(p)));
  const activeDefaults = DEFAULT_EXCLUDES.filter(e => !disabledSet.has(e.path)).map(e => e.path);
  const userExcludes = anchorUserExcludes(excludePaths);
  return [...new Set([...activeDefaults, ...userExcludes])];
}

/**
 * Filesystem metadata the OS writes into a directory on its own, after the
 * manifest was sealed. The backup destination is commonly an iCloud/Finder
 * folder (see `listSnapshots`), so simply BROWSING a snapshot in Finder drops a
 * `.DS_Store` beside the data — which the unmanifested-file check below would
 * then read as tampering and refuse to restore, permanently, on a snapshot that
 * is byte-for-byte intact. These names are skipped by the inventory AND
 * excluded from the restore transfer, so "everything transferred was verified"
 * still holds.
 */
const OS_METADATA_FILES = new Set(['.DS_Store', '.localized', 'Thumbs.db', 'desktop.ini']);
export const isOsMetadataFile = (name) => OS_METADATA_FILES.has(name) || name.startsWith('._');

/**
 * rsync filter form of `OS_METADATA_FILES`. Deliberately UNANCHORED, unlike
 * every path exclude in `DEFAULT_EXCLUDES`: these are basenames the OS writes
 * into any directory, so matching at every depth is the point, not a bug.
 */
export const OS_METADATA_RSYNC_EXCLUDES = [...OS_METADATA_FILES, '._*'].map(name => `--exclude=${name}`);

/**
 * Data-root files a restore never installs. Some snapshots retain them as
 * recovery evidence; Tailcat authority is excluded from new snapshots too. `database-authority.json` names which database backend a
 * completed cutover retired ON THE MACHINE THAT RAN IT. Installing another
 * machine's record (or an older snapshot's, after a reverse cutover) would fence
 * a healthy local backend as `DATABASE_RETIRED_BACKEND`, including across
 * restarts. The destination keeps whatever authority it already has,
 * byte-for-byte: absent stays absent, damaged stays damaged. Root-anchored
 * relative names, like `DEFAULT_EXCLUDES`; this one list feeds the rsync
 * filter, the manifest selection and the scope inventory so preview,
 * verification and execution cannot disagree.
 */
const RESTORE_PRESERVED_FILES = Object.freeze([
  'tailcat-serve.json', 'tailcat-serve.addr',
  'database-authority.json', 'peer-execution', 'peer-execution-catalog.json', 'peer-execution-grants.json', 'peer-execution-authority.json', 'peer-execution-recovery.jsonl', 'workflow-maintenance', 'backup-admission', 'cos/agents/.branch-policy-revision',
]);
// Matched case-insensitively (rsync has no such flag, so each letter becomes a
// `[xX]` class): on a case-insensitive volume a `Database-Authority.json` entry
// would otherwise overwrite the destination's lowercase record.
const caseInsensitiveGlob = (name) => name.replace(/[a-z]/gi, ch => `[${ch.toLowerCase()}${ch.toUpperCase()}]`);
export const RESTORE_PRESERVED_RSYNC_EXCLUDES = [
  ...RESTORE_PRESERVED_FILES.map(name => `--exclude=/${caseInsensitiveGlob(name)}`),
  `--exclude=/${caseInsensitiveGlob('tailcat-serve.json.*.tmp')}`,
];
export const isRestorePreservedPath = (relativePath) => {
  if (typeof relativePath !== 'string') return false;
  const normalized = relativePath.toLowerCase();
  return /^tailcat-serve\.json\.[^/]+\.tmp$/.test(normalized)
    || RESTORE_PRESERVED_FILES.some(path => normalized === path || normalized.startsWith(`${path}/`));
};

// A filter naming a preserved file would otherwise be a silent no-op restore.
// Compared case-insensitively after dropping empty/`.` segments, so
// `./Database-Authority.json/` cannot slip past on a case-insensitive volume.
export const restoreScopeIsPreservedFile = (subdirFilter) => {
  const normalized = subdirFilter?.split('/').filter(part => part && part !== '.').join('/').toLowerCase();
  return isRestorePreservedPath(normalized);
};

/**
 * `instances.json` holds this install's federation identity (`self.instanceId`),
 * its peers and their pair secrets. A shared destination offers every machine's
 * snapshots, so installing another machine's file would give two live installs
 * one identity: each claims the other's CoS tasks and signs pushes with the
 * other's pair credentials (#12596). A restore therefore installs it only when
 * the identities match, the live install has none, or the operator adopts the
 * snapshot's identity (replacing a retired machine). Otherwise it is preserved
 * through the same three places as RESTORE_PRESERVED_FILES.
 */
export const IDENTITY_FILE = 'instances.json';
export const IDENTITY_RSYNC_EXCLUDE = `--exclude=/${caseInsensitiveGlob(IDENTITY_FILE)}`;
export const isIdentityPath = relativePath => typeof relativePath === 'string' && relativePath.toLowerCase() === IDENTITY_FILE;
