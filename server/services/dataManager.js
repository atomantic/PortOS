import { readdir, stat, rm, writeFile as fsWriteFile } from 'fs/promises';
import { join, relative, resolve, isAbsolute } from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { PATHS, ensureDir } from '../lib/fileUtils.js';

const execFileAsync = promisify(execFile);
const DATA_DIR = PATHS.data;

// Every top-level directory PortOS can create under `data/` needs an entry here.
// A missing entry doesn't just show "Unknown category" on the Data Manager — it
// also strips the Archive/Purge affordances, so the biggest thing on a cleanup
// page becomes the one thing the cleanup page refuses to act on (issue #3285).
// `dataManager.categories.test.js` enumerates the directories the codebase can
// emit and fails when one of them is unclassified.
//
// Flag semantics — be conservative, the user cannot undo a purge:
//   archivable — worth tarring into `data/backup/`. False for large binary trees
//     (the tarball lands *inside* data/, so archiving them grows the very number
//     the user came here to shrink) and for anything holding secrets.
//   deletable  — the bytes are genuinely reproducible (caches, ephemeral working
//     dirs, re-downloadable assets) or are already duplicated elsewhere. False
//     whenever purging would destroy the only copy of generated or uploaded work.
export const CATEGORIES = {
  'agents': { label: 'Agents', description: 'Agent personality data', archivable: false, deletable: false },
  'ask-conversations': { label: 'Ask Conversations', description: 'Saved Ask chat transcripts', archivable: true, deletable: false },
  'audio': { label: 'Audio', description: 'Rendered voice-over lines referenced by pipeline issues', archivable: true, deletable: false },
  'autofixer': { label: 'Autofixer', description: 'Autofixer run data', archivable: true, deletable: true },
  'avatar': { label: 'Avatar', description: 'Uploaded avatar images', archivable: true, deletable: false },
  'backup': { label: 'Backups', description: 'Data backup archives', archivable: false, deletable: true },
  'brain': { label: 'Brain', description: 'Brain items and sync log', archivable: true, deletable: false },
  // Legacy location — current installs download to ~/Downloads (PATHS.browserDownloads),
  // but installs that predate that move still carry the dir, and backup still excludes it.
  'browser-downloads': { label: 'Browser Downloads', description: 'Files the agent browser downloaded — re-downloadable, safe to purge', archivable: false, deletable: true },
  'browser-profile': { label: 'Browser Profile', description: 'Chrome/Chromium browser data', archivable: false, deletable: true },
  'calendar': { label: 'Calendar', description: 'Calendar sync data', archivable: true, deletable: false },
  'certs': { label: 'TLS Certificates', description: 'HTTPS certificate and private key — purging drops the install back to HTTP', archivable: false, deletable: false },
  'commission-feedback': { label: 'Commission Feedback', description: 'Reactions on creative commissions (file mirror of the Postgres store)', archivable: true, deletable: false },
  'conflict-journal': { label: 'Conflict Journal', description: 'Peer-sync conflict history — diagnostics only, safe to purge', archivable: true, deletable: true },
  'cos': { label: 'Chief of Staff', description: 'Agent data, reports, memories', archivable: true, deletable: false },
  'creative': { label: 'Creative Ledger', description: 'Append-only ledger of creative generation runs', archivable: true, deletable: false },
  'creative-commissions': { label: 'Creative Commissions', description: 'Commission records (file mirror of the Postgres store)', archivable: true, deletable: false },
  'db-dumps': { label: 'DB Dumps', description: 'PostgreSQL database backups', archivable: true, deletable: true },
  'digital-twin': { label: 'Digital Twin', description: 'Identity, goals, character data', archivable: true, deletable: false },
  'games': { label: 'Games', description: 'Game project records and assets', archivable: true, deletable: false },
  'health': { label: 'Apple Health', description: 'Daily health JSON snapshots', archivable: true, deletable: false },
  'image-clean-tmp': { label: 'Image Cleaner Scratch', description: 'Ephemeral working files for Image Cleaner renders — swept automatically, safe to purge', archivable: false, deletable: true },
  'image-refs': { label: 'Image References', description: 'Reference images uploaded for multi-reference edits — still served to existing renders', archivable: true, deletable: false },
  'image-to-3d': { label: 'Image to 3D', description: 'Generated GLB meshes — the only copy; records live in Postgres', archivable: false, deletable: false },
  'images': { label: 'Images', description: 'Uploaded and generated images', archivable: true, deletable: true },
  'insights': { label: 'Insights', description: 'Derived goal scorecards and insights — rebuilt on the next insights run', archivable: true, deletable: true },
  'jira-reports': { label: 'Jira Reports', description: 'Generated Jira reports — regenerable from Jira', archivable: true, deletable: true },
  'loops': { label: 'Loops', description: 'Output history from scheduled loop runs', archivable: true, deletable: false },
  'lora-datasets': { label: 'LoRA Datasets', description: 'Training images and captions for LoRA runs — uploaded source material, not regenerable', archivable: false, deletable: false },
  'loras': { label: 'LoRAs', description: 'LoRA adapter files for image generation', archivable: false, deletable: true },
  'meatspace': { label: 'MeatSpace', description: 'Body metrics, blood tests, eyes', archivable: true, deletable: false },
  'media-collections': { label: 'Media Collections', description: 'Media collection records', archivable: true, deletable: false },
  'media-sketches': { label: 'Media Sketches', description: 'Saved sketch canvases used as render inputs', archivable: true, deletable: false },
  'messages': { label: 'Messages', description: 'Email and messaging data', archivable: true, deletable: true },
  'model-personality': { label: 'Model Personality', description: 'Model personality probe results and settings', archivable: true, deletable: false },
  'music': { label: 'Music', description: 'Uploaded and generated background tracks', archivable: true, deletable: false },
  'openclaw': { label: 'OpenClaw', description: 'OpenClaw integration config', archivable: true, deletable: false },
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
  'python': { label: 'Python Runtime', description: 'Managed virtualenv for local ML tooling — rebuilt on the next Python-backed run (re-downloads several GB of wheels)', archivable: false, deletable: true },
  'repos': { label: 'Cloned Repos', description: 'Git repositories cloned by agents', archivable: false, deletable: true },
  'review': { label: 'Review', description: 'Review hub items', archivable: true, deletable: true },
  'runs': { label: 'AI Runs', description: 'Agent run logs and outputs', archivable: true, deletable: true },
  'screenshots': { label: 'Screenshots', description: 'Task-related screenshots', archivable: true, deletable: true },
  'settings': { label: 'Settings', description: 'Per-feature settings files', archivable: true, deletable: false },
  'sharing': { label: 'Peer Sync State', description: 'Peer-sync bookkeeping — purging forces a full resync and can resurrect deleted records', archivable: true, deletable: false },
  'spotify': { label: 'Spotify Sync', description: 'Machine-local Spotify sync cursor and cache — purging resets the cursor and can leave a gap in imported history', archivable: true, deletable: false },
  'sprites': { label: 'Sprites', description: 'Sprite reference art, walk frames, and runtime atlases — the only copy of the generated art; records live in Postgres', archivable: false, deletable: false },
  'story-builder': { label: 'Story Builder', description: 'Story Builder project records', archivable: true, deletable: false },
  'telegram': { label: 'Telegram', description: 'Telegram bot data', archivable: true, deletable: true },
  'templates': { label: 'Visual Templates', description: 'Shipped layout assets used as render anchors', archivable: false, deletable: false },
  'tools': { label: 'Tools', description: 'Tool execution data', archivable: true, deletable: true },
  'training-runs': { label: 'LoRA Training Runs', description: 'Training checkpoints, caches, and sample previews — the finished adapters live in LoRAs and survive a purge; run history in Postgres will point at missing artifacts', archivable: false, deletable: true },
  'universes': { label: 'Universes', description: 'Universe Builder records — bibles, canon, and style references', archivable: true, deletable: false },
  'update-detached': { label: 'Update Control', description: 'Control files for a detached self-update run — safe to purge when no update is running', archivable: false, deletable: true },
  'uploads': { label: 'Uploads', description: 'Files uploaded through the UI and referenced by records', archivable: true, deletable: false },
  'video-thumbnails': { label: 'Video Thumbnails', description: 'JPEG thumbnails for generated videos', archivable: false, deletable: true },
  'videos': { label: 'Videos', description: 'Locally generated videos', archivable: true, deletable: true },
  'writers-room': { label: 'Writers Room', description: 'Writers Room works and story bibles', archivable: true, deletable: false },
  'youtube': { label: 'YouTube Sync', description: 'Machine-local YouTube sync state — purging resets the cursor and can leave a gap in imported history', archivable: true, deletable: false }
};

// Shown for a directory with no CATEGORIES entry. Phrased as an outcome ("we
// don't know whether removing this is safe") rather than a mechanism ("unknown
// category") so the absent Archive/Purge buttons read as a deliberate safety
// stance instead of a broken row.
export const UNKNOWN_CATEGORY_DESCRIPTION = "Not classified — PortOS doesn't know if this is safe to remove";

/**
 * Resolve the display/permission metadata for a `data/` directory name.
 * Adds `classified: false` for the unknown fallback so the client can style
 * the row as "deliberately unactionable" instead of guessing from the copy.
 */
function categoryMeta(name) {
  const known = CATEGORIES[name];
  if (known) return { ...known, classified: true };
  return { label: name, description: UNKNOWN_CATEGORY_DESCRIPTION, archivable: false, deletable: false, classified: false };
}

// Validate category key contains only safe characters
const SAFE_NAME = /^[a-z0-9_-]+$/;

async function getDirSizeAndCount(dirPath) {
  if (!existsSync(dirPath)) return { size: 0, fileCount: 0 };
  const [duOut, findOut] = await Promise.all([
    execFileAsync('du', ['-sk', dirPath], { windowsHide: true, timeout: 30000 })
      .then(r => r.stdout.trim())
      .catch(() => '0'),
    execFileAsync('find', [dirPath, '-type', 'f'], { windowsHide: true, timeout: 30000 })
      .then(r => r.stdout.trim().split('\n').filter(Boolean).length)
      .catch(() => 0)
  ]);
  const kb = typeof duOut === 'string' ? (parseInt(duOut.split('\t')[0], 10) || 0) : 0;
  const fileCount = typeof findOut === 'number' ? findOut : (parseInt(findOut, 10) || 0);
  return { size: kb * 1024, fileCount };
}

export async function getDataOverview() {
  const entries = await readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);
  const dirs = entries.filter(e => e.isDirectory());

  // Parallel: get total size + per-directory sizes in one batch
  const [totalResult, ...dirResults] = await Promise.all([
    getDirSizeAndCount(DATA_DIR),
    ...dirs.map(d => getDirSizeAndCount(join(DATA_DIR, d.name)))
  ]);

  const categories = dirs.map((d, i) => {
    const meta = categoryMeta(d.name);
    return {
      key: d.name,
      path: `data/${d.name}`,
      ...meta,
      ...dirResults[i]
    };
  });

  categories.sort((a, b) => b.size - a.size);

  return {
    totalSize: totalResult.size,
    categories,
    dataDir: 'data'
  };
}

export async function getCategoryDetail(categoryKey) {
  if (!SAFE_NAME.test(categoryKey)) return null;
  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) return null;

  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);

  // Parallel: stat files + getDirSizeAndCount for subdirs
  const itemPromises = entries.map(async (entry) => {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const { size, fileCount } = await getDirSizeAndCount(fullPath);
      return { name: entry.name, type: 'directory', size, fileCount };
    }
    const fileStat = await stat(fullPath).catch(() => null);
    return {
      name: entry.name,
      type: 'file',
      size: fileStat?.size || 0,
      modified: fileStat?.mtime?.toISOString() || null
    };
  });

  const items = await Promise.all(itemPromises);
  items.sort((a, b) => b.size - a.size);

  const totalSize = items.reduce((sum, item) => sum + item.size, 0);
  const meta = categoryMeta(categoryKey);

  return { key: categoryKey, ...meta, totalSize, items };
}

export async function archiveCategory(categoryKey, options = {}) {
  if (!SAFE_NAME.test(categoryKey)) throw new Error('Invalid category name');
  const meta = CATEGORIES[categoryKey];
  if (!meta?.archivable) throw new Error(`Category "${categoryKey}" is not archivable`);

  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) throw new Error(`Category directory not found: ${categoryKey}`);

  const backupDir = join(DATA_DIR, 'backup');
  await ensureDir(backupDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archiveName = `${categoryKey}-${timestamp}.tar.gz`;
  const archivePath = join(backupDir, archiveName);

  // Date-based archiving for daily-file categories (health)
  if (categoryKey === 'health') {
    const daysToKeep = options.daysToKeep ?? 365;
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    const files = await readdir(dirPath).catch(() => []);
    const oldFiles = files.filter(f => f.endsWith('.json') && f.slice(0, 10) < cutoffStr);
    if (oldFiles.length === 0) return { archived: 0, archivePath: null, message: 'No old files to archive' };

    // Write file list to temp file to avoid shell argument limits
    const listPath = join(backupDir, `.filelist-${Date.now()}.txt`);
    await fsWriteFile(listPath, oldFiles.join('\n'));
    await execFileAsync('tar', ['-czf', archivePath, '-C', dirPath, '-T', listPath], { timeout: 120000, windowsHide: true });
    await rm(listPath).catch(() => {});

    for (const f of oldFiles) {
      await rm(join(dirPath, f)).catch(() => {});
    }

    const archiveStat = await stat(archivePath).catch(() => null);
    return { archived: oldFiles.length, archivePath: relative(process.cwd(), archivePath), size: archiveStat?.size || 0 };
  }

  // Generic: archive entire category contents
  await execFileAsync('tar', ['-czf', archivePath, '-C', DATA_DIR, categoryKey], { timeout: 120000, windowsHide: true });
  const archiveStat = await stat(archivePath).catch(() => null);

  return {
    archived: 0,
    archivePath: relative(process.cwd(), archivePath),
    archiveSize: archiveStat?.size || 0
  };
}

export async function purgeCategory(categoryKey, options = {}) {
  if (!SAFE_NAME.test(categoryKey)) throw new Error('Invalid category name');
  const meta = CATEGORIES[categoryKey];
  if (!meta?.deletable) throw new Error(`Category "${categoryKey}" is not purgeable`);

  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) throw new Error(`Category directory not found: ${categoryKey}`);

  if (options.subPath) {
    const resolvedRoot = resolve(dirPath);
    const resolvedTarget = resolve(join(dirPath, options.subPath));
    // Boundary-aware containment check: use path.relative so a prefix like
    // `/data/cat` cannot satisfy containment for `/data/cat2`.
    const rel = relative(resolvedRoot, resolvedTarget);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid subPath');
    await rm(resolvedTarget, { recursive: true, force: true });
  } else {
    const entries = await readdir(dirPath).catch(() => []);
    await Promise.all(entries.map(entry => rm(join(dirPath, entry), { recursive: true, force: true })));
  }

  return { category: categoryKey, subPath: options.subPath || null };
}

export async function getBackups() {
  const backupDir = join(DATA_DIR, 'backup');
  if (!existsSync(backupDir)) return [];

  const entries = await readdir(backupDir, { withFileTypes: true }).catch(() => []);
  const files = entries.filter(e => e.isFile());

  const backups = await Promise.all(files.map(async (entry) => {
    const fileStat = await stat(join(backupDir, entry.name)).catch(() => null);
    return {
      name: entry.name,
      size: fileStat?.size || 0,
      created: fileStat?.birthtime?.toISOString() || fileStat?.mtime?.toISOString() || null
    };
  }));

  backups.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  return backups;
}

// Backup archives are named like `agents-2026-06-30T12-34-56.tar.gz`, so the raw
// filename legitimately contains dots. Validate the dotted value directly — the
// old `filename.replace(/[.]/g,'')` double-pass never checked the real filename,
// leaving only the startsWith(backupDir) guard against traversal (issue #1822).
// The regex forbids `/` and `\`, so no traversal segment can form; the only
// regex-passing names that resolve dangerously are the bare `.`/`..` (e.g.
// join(backupDir,'.') === backupDir), so reject those explicitly.
const SAFE_FILENAME = /^[a-z0-9._-]+$/i;

export async function deleteBackup(filename) {
  if (!SAFE_FILENAME.test(filename) || filename === '.' || filename === '..') {
    throw new Error('Invalid filename');
  }
  const backupDir = join(DATA_DIR, 'backup');
  const fullPath = join(backupDir, filename);
  if (!fullPath.startsWith(backupDir)) throw new Error('Path traversal not allowed');
  await rm(fullPath);
  return { deleted: filename };
}
