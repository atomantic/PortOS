/** Canonical source/install `PATHS`, `dataPath`, and home-directory expansion. */
import { homedir } from 'os';
import { join } from 'path';
import { resolveCodeRootForModule, resolveInstallRoot } from './dataRoot.js';

// The executing checkout's root: code/source paths (repo root for git ops, `lib/slashdo`) stay anchored here so they point at the checkout that loaded the code.
const CODE_ROOT = resolveCodeRootForModule(import.meta.url);

// The install root holding the runtime `data/` tree. An explicit PORTOS_DATA_ROOT outranks the executing-file location so a process booted from a CoS agent git worktree resolves `data/` to the real install (#1947);
// falls back to CODE_ROOT otherwise. Only `data/*` paths follow this.
const INSTALL_ROOT = resolveInstallRoot(CODE_ROOT);

/** Base directories relative to project root */
export const PATHS = {
  root: CODE_ROOT,
  // The data-bearing install root (parent of `data/`): equals `root` normally, diverges when PORTOS_DATA_ROOT pins a different tree (#1947). Use it, not `root`, for anything one level above `data/` (e.g. `data/migrations.applied.json`).
  installRoot: INSTALL_ROOT,
  data: join(INSTALL_ROOT, 'data'),
  cos: join(INSTALL_ROOT, 'data/cos'),
  brain: join(INSTALL_ROOT, 'data/brain'),
  digitalTwin: join(INSTALL_ROOT, 'data/digital-twin'),
  health: join(INSTALL_ROOT, 'data/health'),
  runs: join(INSTALL_ROOT, 'data/runs'),
  memory: join(INSTALL_ROOT, 'data/cos/memory'),
  cosAgents: join(INSTALL_ROOT, 'data/cos/agents'),  // CoS sub-agents
  scripts: join(INSTALL_ROOT, 'data/cos/scripts'),
  reports: join(INSTALL_ROOT, 'data/cos/reports'),
  // AI Agent Personalities data
  agentPersonalities: join(INSTALL_ROOT, 'data/agents'),
  meatspace: join(INSTALL_ROOT, 'data/meatspace'),
  calendar: join(INSTALL_ROOT, 'data/calendar'),
  messages: join(INSTALL_ROOT, 'data/messages'),
  screenshots: join(INSTALL_ROOT, 'data/screenshots'),
  uploads: join(INSTALL_ROOT, 'data/uploads'),
  cosAttachments: join(INSTALL_ROOT, 'data/cos/attachments'),
  worktrees: join(INSTALL_ROOT, 'data/cos/worktrees'),
  repos: join(INSTALL_ROOT, 'data/repos'),
  browserProfile: join(INSTALL_ROOT, 'data/browser-profile'),
  browserDownloads: join(homedir(), 'Downloads'),
  digests: join(INSTALL_ROOT, 'data/cos/digests'),
  promptSkills: join(INSTALL_ROOT, 'data/prompts/skills'),
  promptSkillsJobs: join(INSTALL_ROOT, 'data/prompts/skills/jobs'),
  decisions: join(INSTALL_ROOT, 'data/cos/decisions'),
  telegram: join(INSTALL_ROOT, 'data/telegram'),
  templates: join(INSTALL_ROOT, 'data/prompts/templates'),
  // Visual template assets (e.g. the character reference-sheet layout PNG used as the init-image anchor). Distinct from the legacy prompt-template `templates` dir; shipped via data.reference/templates/.
  visualTemplates: join(INSTALL_ROOT, 'data/templates'),
  settings: join(INSTALL_ROOT, 'data/settings'),
  tools: join(INSTALL_ROOT, 'data/tools'),
  images: join(INSTALL_ROOT, 'data/images'),
  // Uploaded multi-reference inputs for FLUX.2 multi-ref edits: a sibling of `images/` so the gallery's flat `.png` enumeration never surfaces them.
  imageRefs: join(INSTALL_ROOT, 'data/image-refs'),
  // Ephemeral working dir for the Image Cleaner's GPU FLUX round-trip (#2264): `<jobId>-init.png` / `<jobId>-result.png`, so the cleaner renders WITHOUT writing a gallery file + sidecar. A sibling of `images/`; swept by imageCleanTmpGc.js on an age gate; not federated.
  imageCleanTmp: join(INSTALL_ROOT, 'data/image-clean-tmp'),
  // PROVIDER-side staging for conditioning images an allowlisted peer uploaded ahead of a federated render (ADR docs/decisions/2026-08-22-federated-media-input-assets.md rule 1), named `<callerHash>-<sha256>.<ext>` and swept on a TTL.
  // Its own root, not a corner of `images/` or `uploads/`: these are ANOTHER machine's bytes held briefly for one job, and under `images/` the gallery would enumerate them and sync would federate them onward
  // (a failure already hit with temp files in data/images). Excluded from backups for the same reason.
  federatedMediaInbox: join(INSTALL_ROOT, 'data/federated-media-inbox'),
  // HTML Pages bench pages as files (`<runId>/<n>-<slug>.html`), so each can be downloaded or opened by path; html_page_runs in Postgres stays the record, and a missing file is rewritten from it. Machine-local like the runs.
  htmlPages: join(INSTALL_ROOT, 'data/html-pages'),
  loras: join(INSTALL_ROOT, 'data/loras'),
  // Per-character LoRA training datasets (collectionStore layout: lora-datasets/<id>/index.json + images/*.png); machine-local like `loras/`, never federated.
  loraDatasets: join(INSTALL_ROOT, 'data/lora-datasets'),
  rapidReaderLibrary: join(INSTALL_ROOT, 'data/rapid-reader-library'),
  // LoRA training run artifacts (checkpoints/samples/cache); run RECORDS live in Postgres (lora_training_runs).
  trainingRuns: join(INSTALL_ROOT, 'data/training-runs'),
  // Character voice-profile metadata lives in PostgreSQL; this holds local benchmark WAVs and future engine artifacts. Machine-local, included in normal data backups.
  voiceProfiles: join(INSTALL_ROOT, 'data/voice-profiles'),
  videos: join(INSTALL_ROOT, 'data/videos'),
  models: join(INSTALL_ROOT, 'data/models'),
  videoThumbnails: join(INSTALL_ROOT, 'data/video-thumbnails'),
  // Music Video cover lettering (#10345): director-uploaded typefaces (.ttf/.otf/.woff2) plus their index. Machine-local; in normal backups.
  coverFonts: join(INSTALL_ROOT, 'data/cover-fonts'),
  imageThumbnails: join(INSTALL_ROOT, 'data/image-thumbnails'),
  // Sprite Manager (#2895): per-record asset trees (sprites/<id>/{reference,walk,runs,runtime,atlas}/...); records live in Postgres (sprite_records).
  sprites: join(INSTALL_ROOT, 'data/sprites'),
  // Image-to-3D (#2952): per-record GLB meshes (image-to-3d/<id>/model.glb); records live in Postgres (image_to_3d_models).
  imageTo3d: join(INSTALL_ROOT, 'data/image-to-3d'),
  // Persisted audio renders (voice-over lines), distinct from the in-memory voice-agent synthesis path (services/voice/, which streams over Socket.IO).
  audio: join(INSTALL_ROOT, 'data/audio'),
  // Uploaded + generated background music tracks, separate from `audio/` so a track is reusable across issues.
  music: join(INSTALL_ROOT, 'data/music'),
  // Extracted assets from third-party imports (ChatGPT export images/audio/PDFs), served read-only at `/data/brain-imports/...` so the Memory conversation viewer renders inline assets. Flat per-source dir keyed by the
  // globally-unique asset id (one copy however many conversations reference it); the transcript archive JSON lives at data/brain/imports/<source>/ and is NOT served.
  brainImportAssets: join(INSTALL_ROOT, 'data/brain/imports/assets'),
  // SongBook attachment BYTES (PDF sheet music, images, MIDI): machine-local, only metadata syncs in the brain `songs` record (peers lacking a file render "not on this machine"). Backed up via data/brain/.
  brainSongbook: join(INSTALL_ROOT, 'data/brain/songbook'),
  // Beeper attachment BYTES (#37), content-addressed `<sha256[0..2]>/<sha256>.<ext>`, mirrored lazily on first human view and bounded by `settings.beeper.attachmentBudgetGb`. Machine-local, never federated;
  // excluded from backups by default (overridable) since re-fetchable from Beeper while the source network holds the media.
  beeperAttachments: join(INSTALL_ROOT, 'data/beeper/attachments'),
  slashdo: join(CODE_ROOT, 'lib/slashdo'),
  // Fully-resolved slashdo command bodies, and the claim prompt's epic phase (#16573), for CoS agents to READ on demand instead of pasted into the prompt (#3110). Derived cache, safe to delete; anchored to INSTALL_ROOT (not CODE_ROOT) because the pointer given to an agent must name a path on the running install.
  slashdoResolved: join(INSTALL_ROOT, 'data/cos/slashdo-resolved')
};

/**
 * Get a path under the data directory: `dataPath('cos', 'state.json')` → `<project>/data/cos/state.json`.
 *
 * @param {...string} segments - Path segments to join
 * @returns {string} Full path under data directory
 *
 * @example
 * const filePath = dataPath('cos', 'state.json');
 * // Returns: /path/to/project/data/cos/state.json
 */
export function dataPath(...segments) {
  return join(PATHS.data, ...segments);
}

// `path.join(homedir(), '/.foo')` discards the homedir prefix because of the leading slash, so strip a leading `~/` (or `~\\` on Windows) before joining. Only a leading `~` expands (`iCloud~md~obsidian` is preserved).
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
