/** Canonical install/source roots and path construction helpers. */
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { resolveInstallRoot } from './dataRoot.js';

const __lib_filename = fileURLToPath(import.meta.url);
const __lib_dirname = dirname(__lib_filename);

// The executing checkout's root (where THIS file physically lives). Code/source
// paths — the repo root for git ops, `lib/slashdo` — must stay anchored here so
// they always point at the checkout that loaded the code.
const CODE_ROOT = join(__lib_dirname, '../..');

// The install root that holds the runtime `data/` tree. Prefer an explicit
// PORTOS_DATA_ROOT env var over the executing-file location so a process booted
// from inside a CoS agent git worktree resolves `data/` to the real install
// instead of the worktree's empty checkout (#1947). Falls back to CODE_ROOT
// when the env var is unset (the two coincide for a normal install). Only
// `data/*` paths follow this — source/git paths stay on CODE_ROOT.
const INSTALL_ROOT = resolveInstallRoot(CODE_ROOT);

/**
 * Base directories relative to project root
 */
export const PATHS = {
  root: CODE_ROOT,
  // The data-bearing install root (parent of `data/`). Equals `root` for a
  // normal install; diverges only when PORTOS_DATA_ROOT pins a different tree
  // (worktree boot, #1947). Use this — not `root` — for anything anchored to
  // the `data/` tree but living one level above it (e.g. the migration ledger
  // `data/migrations.applied.json`), so its reader agrees with where boot wrote it.
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
  // Visual template assets (e.g. the character reference-sheet layout PNG used
  // as the init-image anchor by the universe-builder character sheet renderer).
  // Distinct from `templates` above, which is the legacy prompt-template dir.
  // Files here are shipped via data.reference/templates/ on first install.
  visualTemplates: join(INSTALL_ROOT, 'data/templates'),
  settings: join(INSTALL_ROOT, 'data/settings'),
  missions: join(INSTALL_ROOT, 'data/cos/missions'),
  tools: join(INSTALL_ROOT, 'data/tools'),
  images: join(INSTALL_ROOT, 'data/images'),
  // Uploaded multi-reference inputs for FLUX.2 multi-ref edits. Sibling of
  // `images/` rather than a subdir so the gallery's flat `.png` enumeration
  // never surfaces them, and so a future per-render cleanup pass can drop
  // the whole dir without touching the gallery.
  imageRefs: join(INSTALL_ROOT, 'data/image-refs'),
  // Ephemeral working dir for the Image Cleaner's GPU FLUX round-trip (issue
  // #2264). The sync-cleaned init bytes and the finished render land here as
  // `<jobId>-init.png` / `<jobId>-result.png` so the cleaner can render WITHOUT
  // writing a gallery file + sidecar (the default is not to keep the result).
  // A sibling of `images/` — never surfaced by the gallery's flat `.png`
  // enumeration; swept by imageCleanTmpGc.js on an age gate. Not federated.
  imageCleanTmp: join(INSTALL_ROOT, 'data/image-clean-tmp'),
  // PROVIDER-side staging for conditioning images an allowlisted peer uploaded
  // ahead of a federated render (ADR
  // docs/decisions/2026-08-22-federated-media-input-assets.md rule 1). Files are
  // named `<callerHash>-<sha256>.<ext>` and swept on a TTL.
  //
  // Deliberately its own root rather than a corner of `images/` or `uploads/`:
  // these are ANOTHER machine's bytes, held briefly to run one job. Under
  // `images/` the gallery would enumerate them and the sync layer would federate
  // them onward (the failure this repo already hit once with temp files in
  // data/images). Excluded from backups for the same reason — restoring a peer's
  // half-hour-old init image is worth nothing.
  federatedMediaInbox: join(INSTALL_ROOT, 'data/federated-media-inbox'),
  loras: join(INSTALL_ROOT, 'data/loras'),
  // Per-character LoRA training datasets (collectionStore layout:
  // lora-datasets/<id>/index.json + lora-datasets/<id>/images/*.png).
  // Machine-local like `loras/` — datasets never federate.
  loraDatasets: join(INSTALL_ROOT, 'data/lora-datasets'),
  rapidReaderLibrary: join(INSTALL_ROOT, 'data/rapid-reader-library'),
  // LoRA training run artifacts (checkpoints/samples/cache per run). Run
  // RECORDS live in Postgres (lora_training_runs); only artifacts live here.
  trainingRuns: join(INSTALL_ROOT, 'data/training-runs'),
  // Character voice-profile metadata lives in PostgreSQL; this directory holds
  // the local benchmark WAVs and future engine artifacts referenced by it.
  // It deliberately stays machine-local and is included in normal data backups.
  voiceProfiles: join(INSTALL_ROOT, 'data/voice-profiles'),
  videos: join(INSTALL_ROOT, 'data/videos'),
  videoThumbnails: join(INSTALL_ROOT, 'data/video-thumbnails'),
  // Sprite Manager (issue #2895): per-record asset trees
  // (sprites/<id>/{reference,walk,runs,runtime,atlas}/...). Records live in
  // Postgres (sprite_records); only binary artifacts + manifests live here.
  sprites: join(INSTALL_ROOT, 'data/sprites'),
  // Image-to-3D (issue #2952): per-record GLB meshes rendered locally by a
  // target (TRELLIS.2 today), stored as image-to-3d/<id>/model.glb. Records
  // live in Postgres (image_to_3d_models); only the binary GLB lives here.
  imageTo3d: join(INSTALL_ROOT, 'data/image-to-3d'),
  // Persisted audio renders (voice-over lines). Kept distinct from
  // the in-memory voice-agent synthesis path in services/voice/ — that path
  // streams WAV over Socket.IO without ever touching disk.
  audio: join(INSTALL_ROOT, 'data/audio'),
  // Uploaded + (eventually) generated background music tracks. Separate from
  // `audio/` so the user can browse + reuse a track across issues without
  // walking through the VO-line filenames.
  music: join(INSTALL_ROOT, 'data/music'),
  // Extracted assets from third-party imports (ChatGPT export images/audio/
  // PDFs). Served read-only at `/data/brain-imports/...` so the Memory
  // conversation viewer can render inline `![](url)` images and asset links.
  // Flat per-source dir keyed by the asset's globally-unique id, so the same
  // asset referenced from multiple conversations is stored once. The transcript
  // archive JSON lives one level up (data/brain/imports/<source>/) and is NOT
  // served — only this assets subtree is.
  brainImportAssets: join(INSTALL_ROOT, 'data/brain/imports/assets'),
  // SongBook attachment BYTES (PDF sheet music, images, MIDI). Machine-local —
  // only the metadata syncs inside the brain `songs` record; peers lacking a
  // file render "not on this machine". Covered by backup via data/brain/.
  brainSongbook: join(INSTALL_ROOT, 'data/brain/songbook'),
  slashdo: join(CODE_ROOT, 'lib/slashdo'),
  // Fully-resolved slashdo command bodies written for CoS agents to READ on
  // demand instead of receiving them pasted into the prompt (issue #3110).
  // Derived cache, never authored: regenerated on first use each process, safe
  // to delete. Anchored to INSTALL_ROOT (not CODE_ROOT) because the pointer
  // handed to an agent must name a path that exists on the running install.
  slashdoResolved: join(INSTALL_ROOT, 'data/cos/slashdo-resolved')
};

/**
 * Get a path relative to the data directory.
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

// `path.join(homedir(), '/.foo')` discards the homedir prefix because of
// the leading slash, so strip the leading `~/` (or `~\` on Windows) before
// joining. Only expands a leading `~` — embedded `~` chars in path segments
// (e.g. `iCloud~md~obsidian`) are preserved.
export function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return join(homedir(), p.slice(2));
  return p;
}
