import { isPersistentMindScreenshotEntry } from '../lib/persistent/persistentMindAttachmentOwnership.js';

// Names archiveCategory produces: `<category>-<timestamp>[-<uuid>].tar.gz`
// (the uuid is absent on archives written before same-second collisions were
// handled). data/backup/ is shared with the backup service's state.json, so
// listing and deletion are limited to this shape. The pattern excludes `/`,
// `\\` and bare dots, so no traversal segment can form (issue #1822).
export const ARCHIVE_FILENAME = /^[a-z0-9_-]+-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}(?:-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?\.tar\.gz$/i;

// Every top-level directory PortOS can create under `data/` needs an entry here.
// A missing entry doesn't just show "Unknown category" on the Data Manager — it
// also strips the Archive/Purge affordances, so the biggest thing on a cleanup
// page becomes the one thing the cleanup page refuses to act on (issue #3285).
// `server/test/guards/runtime/dataManager.categories.test.js` enumerates the directories the codebase can
// emit and fails when one of them is unclassified.
//
// Flag semantics — be conservative, the user cannot undo a purge:
//   archivable — worth tarring into `data/backup/`. False for large binary trees
//     (the tarball lands *inside* data/, so archiving them grows the very number
//     the user came here to shrink) and for anything holding secrets.
//   archiveExcludes — optional array of tar `--exclude` patterns relative to
//     `data/` for archivable categories that hold secrets in a subdirectory.
//   deletable  — the bytes are genuinely reproducible (caches, ephemeral working
//     dirs, re-downloadable assets) or are already duplicated elsewhere. False
//     whenever purging would destroy the only copy of generated or uploaded work.
//   purgeScope — how much a purge may take at once. Only meaningful when
//     `deletable`; omit it (it resolves to null) on protected categories.
//       'category' — the whole directory can go in one action.
//       'items'    — only a per-item delete (`subPath`) is offered; the
//         category-wide wipe is refused server-side. For a mixed directory of
//         uploads and renders that other records point at, "reclaim space" is a
//         legitimate need but an all-or-nothing wipe is not (issue #3327).
//     `purgeCategory` fails closed: anything other than an explicit 'category'
//     refuses the directory-wide purge, so a missing or misspelled scope can
//     never widen a delete.
//   busyCheck — optional `() => Promise<{ busy, reason }>`. Some directories are
//     genuinely reproducible scratch, yet only while nothing is USING them: a
//     category-wide purge mid-job destroys the working state of a render, a
//     trainer, or a self-update. A category carrying a `busyCheck` refuses the
//     purge with 409 CATEGORY_BUSY while its probe says busy, including
//     per-item deletion: naming a directory does not make a live job safe.
//     Categories with no `busyCheck` are unaffected. Probes live in
//     `dataManagerBusy.js`.
//   purgeFilter — optional `name => boolean`. A category-wide purge removes only
//     the entries it accepts. Use it when the directory also holds files the
//     category's own service owns (backup's state.json and in-flight staging).
// Explicit allowlist: new children of data/cache may be installed runtimes,
// active work or retained state, regardless of the parent directory's name.
const CACHE_ENTRIES = {
  'accelerando.html': { label: 'Accelerando reading cache', type: 'file', description: 'Rebuilt by fetching the author-hosted book again.' },
  'huggingface-repos.json': { label: 'Hugging Face catalog cache', type: 'file', description: 'Rebuilt by fetching repository metadata again.' },
  'codex-usage-inventory': { label: 'Codex usage scan cache', type: 'directory', description: 'Rebuilt from Codex session logs. Clearing it does not delete those logs or saved PortOS usage records, but the next scan takes longer.' },
  runtimes: { label: 'Local model runtimes and weights', description: 'Runtime installations and downloaded models, not temporary files. Open this entry to manage the runtime installations.', sourceHref: '/models/llms-runtimes' },
  mkserve: { label: 'mkserve runtime and weights', description: 'Runtime installation and downloaded models. Manage them on the mkserve card.', sourceHref: '/models/llms-runtimes/mkserve' },
  'runtime-update-review.json': { label: 'Runtime update review state', description: 'PortOS uses this to track runtime update reviews. Kept by Data Manager.' },
};

export function dataCacheEntry(name, type) {
  const known = Object.hasOwn(CACHE_ENTRIES, name) ? CACHE_ENTRIES[name] : null;
  const { type: purgeableType, ...meta } = known ?? { description: 'Not classified as disposable. Kept by Data Manager.' };
  return { ...meta, canPurge: type === purgeableType && Boolean(purgeableType) };
}

export const CATEGORIES = {
  'agents': { label: 'Agents', description: 'Agent personality data', archivable: false, deletable: false },
  'ask-conversations': { label: 'Ask Conversations', description: 'Saved Ask chat transcripts', archivable: true, deletable: false },
  'audio': { label: 'Audio', description: 'Rendered voice-over lines referenced by pipeline issues', archivable: true, deletable: false },
  'autofixer': { label: 'Autofixer', description: 'Autofixer run data', archivable: true, deletable: true, purgeScope: 'category' },
  'avatar': { label: 'Avatar', description: 'Uploaded avatar images', archivable: true, deletable: false },
  // Machine-local ownership authority must survive every generic cleanup action.
  'backup-admission': { label: 'Backup Admission', description: 'Active publication and snapshot ownership — reconcile through backup recovery', archivable: false, deletable: false },
  // data/backup/ also holds the backup service's state.json and .archive-* staging; the purge is archives-only.
  'backup': { label: 'Backups', description: 'Data backup archives', archivable: false, deletable: true, purgeScope: 'category', purgeFilter: name => ARCHIVE_FILENAME.test(name) },
  'blender-models': { label: 'Blender Models', description: 'Blender model workspaces — authored src/ code (the only copy) and immutable builds; records live in Postgres', archivable: false, deletable: false },
  'brain': { label: 'Brain', description: 'Brain items and sync log', archivable: true, deletable: false },
  // The Beeper attachment byte mirror (#37) — the only thing the Beeper feature
  // writes to `data/`; every other Beeper record is Postgres. Not archivable:
  // the tarball would land inside `data/` and grow the number the user came here
  // to shrink, and the bytes are re-fetchable from Beeper anyway. NOT deletable
  // from here either (audit cluster 04, decision 2): the directory holds a
  // single subdirectory, `attachments/`, which the per-item purge form refuses
  // outright (item-scoped purges remove a single FILE and never recurse — see
  // `purgeCategory` below) and the category-wide form was never reachable
  // without `purgeScope: 'category'`. The visible purge control was dead on
  // arrival either way. Reclamation is two paths that both reference-check
  // before touching a byte: the attachment budget sweep (least-recently-viewed
  // eviction, bounded by `settings.beeper.attachmentBudgetGb`) and the
  // per-conversation purge (`DELETE /api/beeper/conversations/:id`, content-
  // addressed so a photo forwarded into three chats survives one being
  // purged). This category reports size only.
  'beeper': { label: 'Beeper Attachments', description: 'Mirrored Beeper attachment bytes — reclaimed by the attachment budget sweep and per-conversation purge, not from here', archivable: false, deletable: false },
  // Legacy location — current installs download to ~/Downloads (PATHS.browserDownloads),
  // but installs that predate that move still carry the dir, and backup still excludes it.
  'browser-downloads': { label: 'Browser Downloads', description: 'Files the agent browser downloaded — re-downloadable, safe to purge', archivable: false, deletable: true, purgeScope: 'category' },
  'browser-profile': { label: 'Browser Profile', description: 'Chrome/Chromium browser data', archivable: false, deletable: true, purgeScope: 'category' },
  cache: { label: 'Local Runtimes and Caches', description: 'Installed runtime files, downloaded models, and rebuildable caches. Only marked entries can be cleared.', archivable: false, deletable: true, purgeScope: 'items', mixed: true },
  'calendar': { label: 'Calendar', description: 'Calendar sync data', archivable: true, deletable: false, archiveExcludes: ['calendar/google-auth'] },
  'cover-fonts': { label: 'Cover Fonts', description: 'Typefaces uploaded for music video cover lettering; covers made with one fall back to a built-in typeface if it is removed', archivable: true, deletable: false },
  'private': { label: 'Private Keys', description: 'Machine-local integration credentials — managed in Settings > Credentials', archivable: false, deletable: false },
  'certs': { label: 'TLS Certificates', description: 'HTTPS certificate and private key — purging drops the install back to HTTP', archivable: false, deletable: false },
  'launch-videos': { label: 'Launch Videos', description: 'App launch-video compositions, plans, captions and rendered deliverables', archivable: true, deletable: false },
  'composition-proofs': { label: 'Composition Proofs', description: 'Contact-sheet review stills from HTML-composition proof renders — re-rendered from source, safe to purge', archivable: false, deletable: true, purgeScope: 'category' },
  'photoreal-blends': { label: 'Photoreal Blender Scenes', description: 'The latest Blender scene built from each Environment greybox for download — rebuilt by the next Photoreal render, safe to purge', archivable: false, deletable: true, purgeScope: 'category' },
  'photoreal-textures': { label: 'Photoreal Textures', description: 'CC0 photo textures downloaded from Poly Haven for Photoreal looks — re-downloaded on the next pick; until then those materials render procedurally', archivable: false, deletable: true, purgeScope: 'category' },
  'photoreal-workspaces': { label: 'Photoreal Render Workers', description: 'Per-run staged input, output and scratch for an in-flight Photoreal Blender render — removed when the run ends', archivable: false, deletable: false },
  'greybox-renders': { label: 'Greybox Render Scratch', description: 'Temporary viewer pages for in-flight greybox shot captures — removed when each render ends', archivable: false, deletable: false },
  // Development artifacts ("ingredients") of Music Video projects — every
  // version of a Cast & Sets sheet, animatic, treatment or storyboard, one
  // immutable file each, referenced by the project record. Not deletable from
  // here: a purge would strand those references (delete the artifact instead).
  'music-video': { label: 'Music Video Development Files', description: 'Versioned development artifacts (check-in sheets, animatics, treatments), composition documents and Blender film workspaces (scripts and their renders) referenced by Music Video projects', archivable: true, deletable: false },
  'music-video-compositions': { label: 'Music Video Overlay Scratch', description: 'Typography overlay frames for an in-flight composed music-video render — removed when the render ends and swept at boot', archivable: false, deletable: false },
  'music-video-film-look': { label: 'Music Video Film Look Scratch', description: 'A staged link to a finished render for its film look pass — removed when the pass ends', archivable: false, deletable: false },
  'music-video-stats-outro': { label: 'Music Video Outro Scratch', description: 'The cutting room floor outro page (fonts and floor stills) for an in-flight music-video render — removed when the render ends and swept at boot', archivable: false, deletable: false },
  'music-video-segments': { label: 'Music Video Shot Renders', description: 'Cached per-shot segments of composed music-video final renders — pruned after each final render and removed with the project; the final render re-renders any that are missing', archivable: false, deletable: false },
  'music-video-song-renders': { label: 'Music Video Composition Render Scratch', description: 'A staged copy of a composition document plus its scene media for an in-flight music-video render — removed when the render ends and swept at boot', archivable: false, deletable: false },
  'code-animation': { label: 'Code Animation Film Workspaces', description: 'Authored Blender film scripts, assets, song context and rendered previews referenced by Production film projects; reclaim generated frames through the film panel', archivable: true, deletable: false },
  'code-animation-workspaces': { label: 'Code Animation Contained Workers', description: 'Per-run staged input, output and scratch for a sandboxed Code Animation worker — removed when the run ends and swept on the next run', archivable: false, deletable: false },
  'code-animations': { label: 'Code Animations', description: 'Generated animation HTML retained with its job history — the only copy of provider-generated work', archivable: true, deletable: false },
  'code-animation-exports': { label: 'Code Animation Export Staging', description: 'Animation HTML plus the frame-exact render shim, staged once per MP4 export — safe to purge', archivable: false, deletable: true, purgeScope: 'category' },
  'commission-feedback': { label: 'Commission Feedback', description: 'Reactions on creative commissions (file mirror of the Postgres store)', archivable: true, deletable: false },
  'conflict-journal': { label: 'Conflict Journal', description: 'Peer-sync conflict history — diagnostics only, safe to purge', archivable: true, deletable: true, purgeScope: 'category' },
  'cos': { label: 'Chief of Staff', description: 'Agent data, reports, memories', archivable: true, deletable: false },
  'creative': { label: 'Creative Ledger', description: 'Append-only ledger of creative generation runs', archivable: true, deletable: false },
  'creative-commissions': { label: 'Creative Commissions', description: 'Commission records (file mirror of the Postgres store)', archivable: true, deletable: false },
  'database-maintenance': { label: 'Database Maintenance', description: 'Machine-local database cutover fence and active recovery state', archivable: false, deletable: false },
  'db-dumps': { label: 'DB Dumps', description: 'PostgreSQL database backups', archivable: true, deletable: true, purgeScope: 'category' },
  'digital-twin': { label: 'Digital Twin', description: 'Identity, goals, character data', archivable: true, deletable: false },
  'eidoverse': { label: 'Eidoverse Worlds', description: 'Machine-local world history owned by the optional Eidoverse runtime — backed up and not federated', archivable: true, deletable: false },
  'fableloom-shot-runs': { label: 'FableLoom Shot Runs', description: 'Machine-local shot-planning drafts, reviews and resume checkpoints — regenerating them costs provider calls', archivable: true, deletable: false },
  'fableloom': { label: 'FableLoom', description: 'Branching-narrative records (file mirror of the Postgres store)', archivable: true, deletable: false },
  // Another machine's conditioning images, staged for one federated render and
  // swept on a TTL (#4348). Not archivable for the same reason it is excluded
  // from backups: none of it is this install's data, and a restored entry is
  // either already expired or already rendered. Purgeable as a category —
  // deleting a staged asset only forces the peer that owns it to re-upload,
  // which is one transfer, not lost work.
  'federated-media-inbox': { label: 'Federated Media Inbox', description: 'Source images peers uploaded for federated renders — expire automatically, safe to purge when no federated render is in flight', archivable: false, deletable: true, purgeScope: 'category', busyCheck: async (state) => (await import('./dataManagerBusy.js')).federatedMediaInboxBusy(state) },
  'games': { label: 'Games', description: 'Game project records and assets', archivable: true, deletable: false },
  'health': { label: 'Apple Health', description: 'Daily health JSON snapshots', archivable: true, deletable: false },
  'image-clean-tmp': { label: 'Image Cleaner Scratch', description: 'Ephemeral working files for Image Cleaner renders — swept automatically, safe to purge when no render is in flight', archivable: false, deletable: true, purgeScope: 'category', busyCheck: async (state) => (await import('./dataManagerBusy.js')).imageCleanTmpBusy(state) },
  'image-render-usage': { label: 'Image Render Usage', description: 'Durable image accounting receipts — retain historical usage and deduplication identities', archivable: true, deletable: false },
  'image-render-usage-backfills': { label: 'Image Usage Recovery', description: 'Private historical import plans, preservation fingerprints and recovery journals', archivable: true, deletable: false },
  // Each HTML Pages page as a file; html_page_runs in Postgres is the record and rewrites a missing file on request, and deleting a run removes its folder.
  'html-pages': { label: 'HTML Pages', description: 'HTML Pages bench pages as .html files, one folder per run — rewritten from the run record if removed', archivable: true, deletable: false },
  'image-refs': { label: 'Image References', description: 'Reference images uploaded for multi-reference edits — still served to existing renders', archivable: true, deletable: false },
  'image-to-3d': { label: 'Image to 3D', description: 'Generated GLB meshes — the only copy; records live in Postgres', archivable: false, deletable: false },
  'images': { label: 'Images', description: 'Uploaded and generated images — delete individually; gallery, pipeline, and collection records point at these files', archivable: true, deletable: true, purgeScope: 'items' },
  // Not only derived output: the goal scorecard's hand-authored rule overrides
  // and its settings live here too, and nothing regenerates them.
  'insights': { label: 'Insights', description: 'Goal scorecard rule overrides and settings, plus the derived scorecard, themes and narrative', archivable: true, deletable: false },
  // Project-specific jev heads plus the corpora and cached embeddings behind
  // them.
  //
  // NOT deletable: the corpus and the embedding cache regenerate, but a trained
  // head does not — the forge queries that built its corpus return different
  // rows a month later, and it is the one artifact here an operator made an
  // adoption decision about. Purging the category would silently return scope
  // adherence to the stock scorer with nothing to restore.
  //
  // NOT archivable either, and for the opposite reason: this tree is mostly the
  // embedding cache, which `backup.js` excludes precisely because it is
  // gigabytes of pure cache. Archiving gzips exactly those gigabytes INTO
  // `data/backup/` — growing the directory an operator opened this page to
  // shrink, and blowing the shared tar timeout on the way. The few kilobytes
  // worth keeping (the heads) are already in every snapshot.
  'jev': { label: 'jev Project Heads', description: 'Trained project-specific scorer heads, their training corpora, and cached frozen-encoder outputs — machine-local; a head is not regenerable once its corpus is stale, and the cache beside it is bulk that rebuilds', archivable: false, deletable: false },
  'jira-reports': { label: 'Jira Reports', description: 'Generated Jira reports — regenerable from Jira', archivable: true, deletable: true, purgeScope: 'category' },
  'loops': { label: 'Loops', description: 'Output history from scheduled loop runs', archivable: true, deletable: false },
  'lora-datasets': { label: 'LoRA Datasets', description: 'Training images and captions for LoRA runs — uploaded source material, not regenerable', archivable: false, deletable: false },
  // Measured local-model assessments are reproducible. Preserve jev's shadow
  // counters, which share this directory but record scheduled observations.
  'local-llm': { label: 'Local Model Assessments', description: 'Measured fit and performance results for installed local models — re-runnable and stale after a hardware or backend change; jev agreement counters are kept', archivable: true, deletable: true, purgeScope: 'category', purgeFilter: name => name.toLowerCase() !== 'jev-shadow.json' },
  'loras': { label: 'LoRAs', description: 'Trained and downloaded LoRA adapters — included in backups by default; a trained one is not regenerable without hours of GPU retraining', archivable: false, deletable: false },
  'meatspace': { label: 'MeatSpace', description: 'Body metrics, blood tests, eyes', archivable: true, deletable: false },
  'media-collections': { label: 'Media Collections', description: 'Media collection records', archivable: true, deletable: false },
  'media-sketches': { label: 'Media Sketches', description: 'Saved sketch canvases used as render inputs', archivable: true, deletable: false },
  // Not deletable: drafts, the send-attempt audit (`delivery_unknown` records
  // that stop a possibly-sent message being resent), triage rules and account
  // configuration are user-authored and not regenerable. Only the mail cache is
  // reproducible, and it is bounded per account, so no cache-only purge is offered.
  'messages': { label: 'Messages', description: 'Message accounts, drafts, triage rules and cached mail — drafts and rules are not regenerable', archivable: true, deletable: false },
  'migrations': { label: 'Legacy Migration Ledger', description: 'Pre-2026-05 location of the migration applied-list — the next migration run moves it to migrations.applied.json, and setup removes the empty folder', archivable: false, deletable: false },
  'model-personality': { label: 'Model Personality', description: 'Model personality probe results and settings', archivable: true, deletable: false },
  'model-tests': { label: 'Model Capability Tests', description: 'Throwaway agent sandboxes from the capability test suite — recreated per run, safe to purge', archivable: false, deletable: true, purgeScope: 'category' },
  'models': { label: '3D Models', description: 'Uploaded GLB layouts referenced by catalog places — retain the authored source files', archivable: true, deletable: false },
  'music': { label: 'Music', description: 'Uploaded and generated background tracks', archivable: true, deletable: false },
  'openclaw': { label: 'OpenClaw', description: 'OpenClaw integration config', archivable: false, deletable: false },
  'peer-execution': { label: 'Peer Execution Recovery', description: 'Machine-local launch evidence and completion receipts required to reconcile authorized peer maintenance — preserve unresolved operations', archivable: false, deletable: false },
  'pipeline-comparative-rank': { label: 'Comparative Rank', description: 'Cached comparative issue rankings — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-editorial': { label: 'Editorial Analysis', description: 'Cached editorial analyses — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-editorial-health': { label: 'Editorial Health', description: 'Cached editorial health scores — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-foundation-judge': { label: 'Foundation Judge', description: 'Cached foundation-judge verdicts — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-issues': { label: 'Pipeline Issues (legacy)', description: 'Pre-Postgres issue files kept as the recovery source until the migration is confirmed', archivable: true, deletable: false },
  'pipeline-judge': { label: 'Pipeline Judge', description: 'Cached pipeline-judge verdicts — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-pov-rewrites': { label: 'POV Rewrites', description: 'Cached perspective rewrites — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-reader-panel': { label: 'Reader Panel', description: 'Cached reader-panel reactions — re-running them costs LLM calls', archivable: true, deletable: false },
  'pipeline-series': { label: 'Pipeline Series (legacy)', description: 'Pre-Postgres series files kept as the recovery source until the migration is confirmed', archivable: true, deletable: false },
  'pipeline-series-review': { label: 'Series Review', description: 'Cached series reviews — re-running them costs LLM calls', archivable: true, deletable: false },
  'privacy': { label: 'Privacy', description: 'Data-broker opt-out records and request history', archivable: true, deletable: false },
  'prompts': { label: 'Prompts', description: 'AI prompt templates', archivable: false, deletable: false },
  // agentskills.io SKILL.md directories the user and the mind author (#17387); hand-edited, never regenerated.
  'skills': { label: 'Agent Skills', description: 'Local procedural skills (SKILL.md directories) offered to CoS agents', archivable: true, deletable: false },
  'venvs': { label: 'Optional SDK Runtimes', description: 'Explicitly installed Python environments for media SDKs; reinstall with the corresponding setup command', archivable: false, deletable: false },
  'python': { label: 'Python Runtime', description: 'Managed virtualenv for local ML tooling — rebuilt on the next Python-backed run (re-downloads several GB of wheels)', archivable: false, deletable: true, purgeScope: 'category' },
  // A pasted or URL-fetched book is the user's only copy — the shelf is not a
  // cache of anything re-fetchable, so it is neither archivable nor deletable.
  'rapid-reader-library': { label: 'Rapid Reader Shelf', description: 'Saved books for Rapid Reader — pasted and URL-imported prose kept on this machine, not regenerable', archivable: false, deletable: false },
  'repos': { label: 'Cloned Repos', description: 'Git repositories cloned by agents. Managed app checkouts (Eidoverse Worlds and its video repo) are kept on purge',archivable: false, deletable: true, purgeScope: 'category' },
  // Not deletable: user todos, pending CoS action requests and private security
  // assessment reports live here and have no other copy.
  'review': { label: 'Review', description: 'Review Hub todos, action requests and assessment reports', archivable: true, deletable: false },
  'rigging': { label: 'Rigging Clip Library', description: 'User-dropped animation-bearing GLB source files for retargeting — the only copy of assets you supplied', archivable: false, deletable: false },
  'runs': { label: 'AI Runs', description: 'Agent run logs and outputs', archivable: true, deletable: true, purgeScope: 'category' },
  'screenshots': { label: 'Screenshots', description: 'Task screenshots and images dropped into shell sessions — shell drops auto-delete after 7 days, others after 30 days unless an open task still uses them; Persistent Mind attachments are retained by Mind', archivable: true, deletable: true, purgeScope: 'category', purgeFilter: name => !isPersistentMindScreenshotEntry(name) },
  'settings': { label: 'Settings', description: 'Per-feature settings files', archivable: true, deletable: false },
  'sharing': { label: 'Peer Sync State', description: 'Peer-sync bookkeeping — purging forces a full resync and can resurrect deleted records', archivable: true, deletable: false },
  'spotify': { label: 'Spotify Sync', description: 'Machine-local Spotify sync cursor and cache — purging resets the cursor and can leave a gap in imported history', archivable: false, deletable: false },
  'sprites': { label: 'Sprites', description: 'Sprite reference art, walk frames, and runtime atlases — the only copy of the generated art; records live in Postgres', archivable: false, deletable: false },
  'story-builder': { label: 'Story Builder', description: 'Story Builder project records', archivable: true, deletable: false },
  'storyboards': { label: 'Storyboards', description: 'Storyboard beats and panels (file mirror of the Postgres store)', archivable: true, deletable: false },
  'storyboard-recipes': { label: 'Storyboard recipes', description: 'Saved panel maker recipes (file mirror of the Postgres store)', archivable: true, deletable: false },
  'supercollider': { label: 'SuperCollider Runtime', description: 'Machine-local readiness evidence for the managed SuperCollider image, in-flight render scratch and 24-hour render previews — re-created by npm run setup:supercollider, safe to purge', archivable: false, deletable: true, purgeScope: 'category' },
  'telegram': { label: 'Telegram', description: 'Your answers to Telegram goal check-ins', archivable: true, deletable: false },
  'templates': { label: 'Visual Templates', description: 'Shipped layout assets used as render anchors', archivable: false, deletable: false },
  // Not execution logs: one JSON config per onboard tool, spliced into CoS
  // prompts. Image Gen settings are the only writer, so a purge would drop
  // "Available Tools" after the next restart and reclaim almost nothing.
  'tools': { label: 'Tools', description: 'Onboard tool registry listed in CoS agent prompts — rebuilt only when Image Gen settings are saved', archivable: true, deletable: false },
  'training-runs': { label: 'LoRA Training Runs', description: 'Retired training checkpoints and previews; delete it from the LoRAs page. May contain unique adapters.', archivable: false, deletable: false, busyCheck: async (state) => (await import('./dataManagerBusy.js')).trainingRunsBusy(state) },
  'universes': { label: 'Universes', description: 'Universe Builder records — bibles, canon, and style references', archivable: true, deletable: false },
  'update-detached': { label: 'Update Control', description: 'Control files for a detached self-update run — safe to purge when no update is running', archivable: false, deletable: true, purgeScope: 'category', busyCheck: async (state) => (await import('./dataManagerBusy.js')).updateDetachedBusy(state) },
  'uploads': { label: 'Uploads', description: 'Files uploaded through the UI and referenced by records', archivable: true, deletable: false },
  'video-thumbnails': { label: 'Video Thumbnails', description: 'JPEG thumbnails for generated videos', archivable: false, deletable: true, purgeScope: 'category' },
  'image-thumbnails': { label: 'Image Thumbnails', description: 'Regenerable WebP previews for generated images', archivable: false, deletable: true, purgeScope: 'category' },
  'videos': { label: 'Videos', description: 'Locally generated videos — delete individually; the render is the only copy and re-rendering costs provider spend', archivable: true, deletable: true, purgeScope: 'items' },
  'voice-profiles': { label: 'Voice Profiles', description: 'Machine-local voice profile source recordings, benchmarks, and local engine artifacts', archivable: true, deletable: false },
  'writers-room': { label: 'Writers Room', description: 'Writers Room works and story bibles', archivable: true, deletable: false },
  'youtube': { label: 'YouTube Sync', description: 'Machine-local YouTube sync state — purging resets the cursor and can leave a gap in imported history', archivable: true, deletable: false }
};
