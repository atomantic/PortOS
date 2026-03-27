import { readdir, stat, rm } from 'fs/promises';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

const DATA_DIR = join(process.cwd(), 'data');

// Category definitions with display names and archivability
const CATEGORIES = {
  'browser-profile': { label: 'Browser Profile', description: 'Chrome/Chromium browser data', archivable: false, deletable: true },
  'repos': { label: 'Cloned Repos', description: 'Git repositories cloned by agents', archivable: false, deletable: true },
  'health': { label: 'Apple Health', description: 'Daily health JSON snapshots', archivable: true, deletable: false },
  'meatspace': { label: 'MeatSpace', description: 'Body metrics, blood tests, eyes', archivable: true, deletable: false },
  'autofixer': { label: 'Autofixer', description: 'Autofixer run data', archivable: true, deletable: true },
  'db-dumps': { label: 'DB Dumps', description: 'PostgreSQL database backups', archivable: true, deletable: true },
  'screenshots': { label: 'Screenshots', description: 'Task-related screenshots', archivable: true, deletable: true },
  'cos': { label: 'Chief of Staff', description: 'Agent data, reports, memories', archivable: true, deletable: false },
  'runs': { label: 'AI Runs', description: 'Agent run logs and outputs', archivable: true, deletable: true },
  'images': { label: 'Images', description: 'Uploaded and generated images', archivable: true, deletable: true },
  'calendar': { label: 'Calendar', description: 'Calendar sync data', archivable: true, deletable: false },
  'digital-twin': { label: 'Digital Twin', description: 'Identity, goals, character data', archivable: true, deletable: false },
  'messages': { label: 'Messages', description: 'Email and messaging data', archivable: true, deletable: true },
  'prompts': { label: 'Prompts', description: 'AI prompt templates', archivable: false, deletable: false },
  'brain': { label: 'Brain', description: 'Brain items and sync log', archivable: true, deletable: false },
  'agents': { label: 'Agents', description: 'Agent personality data', archivable: false, deletable: false },
  'review': { label: 'Review', description: 'Review hub items', archivable: true, deletable: true },
  'tools': { label: 'Tools', description: 'Tool execution data', archivable: true, deletable: true },
  'backup': { label: 'Backups', description: 'Data backup archives', archivable: false, deletable: true },
  'telegram': { label: 'Telegram', description: 'Telegram bot data', archivable: true, deletable: true }
};

/**
 * Get size of a directory using du (fast, accurate)
 */
function getDirSize(dirPath) {
  if (!existsSync(dirPath)) return 0;
  const output = execSync(`du -sk "${dirPath}" 2>/dev/null || echo "0"`, {
    encoding: 'utf-8',
    windowsHide: true
  }).trim();
  const kb = parseInt(output.split('\t')[0], 10) || 0;
  return kb * 1024; // bytes
}

/**
 * Count files in a directory
 */
function countFiles(dirPath) {
  if (!existsSync(dirPath)) return 0;
  const output = execSync(`find "${dirPath}" -type f 2>/dev/null | wc -l`, {
    encoding: 'utf-8',
    windowsHide: true
  }).trim();
  return parseInt(output, 10) || 0;
}

/**
 * Get overview of all data categories with sizes
 */
export async function getDataOverview() {
  const totalSize = getDirSize(DATA_DIR);

  // Get top-level items
  const entries = await readdir(DATA_DIR, { withFileTypes: true }).catch(() => []);

  const categories = [];
  let categorizedSize = 0;

  for (const entry of entries) {
    const fullPath = join(DATA_DIR, entry.name);

    if (entry.isDirectory()) {
      const size = getDirSize(fullPath);
      const fileCount = countFiles(fullPath);
      const meta = CATEGORIES[entry.name] || {
        label: entry.name,
        description: 'Unknown category',
        archivable: false,
        deletable: false
      };

      categorizedSize += size;
      categories.push({
        key: entry.name,
        path: relative(process.cwd(), fullPath),
        ...meta,
        size,
        fileCount
      });
    } else {
      // Top-level files
      const fileStat = await stat(fullPath).catch(() => null);
      if (fileStat) categorizedSize += fileStat.size;
    }
  }

  // Sort by size descending
  categories.sort((a, b) => b.size - a.size);

  // Count top-level JSON files
  const topLevelFiles = entries.filter(e => !e.isDirectory());

  return {
    totalSize,
    categorizedSize,
    topLevelFileCount: topLevelFiles.length,
    categories,
    dataDir: relative(process.cwd(), DATA_DIR)
  };
}

/**
 * Get detailed breakdown of a specific category
 */
export async function getCategoryDetail(categoryKey) {
  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) return null;

  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);
  const items = [];

  for (const entry of entries) {
    const fullPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      items.push({
        name: entry.name,
        type: 'directory',
        size: getDirSize(fullPath),
        fileCount: countFiles(fullPath)
      });
    } else {
      const fileStat = await stat(fullPath).catch(() => null);
      items.push({
        name: entry.name,
        type: 'file',
        size: fileStat?.size || 0,
        modified: fileStat?.mtime?.toISOString() || null
      });
    }
  }

  items.sort((a, b) => b.size - a.size);

  const meta = CATEGORIES[categoryKey] || { label: categoryKey, archivable: false, deletable: false };

  return {
    key: categoryKey,
    ...meta,
    totalSize: getDirSize(dirPath),
    items
  };
}

/**
 * Archive a category's old data (compress into backup)
 */
export async function archiveCategory(categoryKey, options = {}) {
  const meta = CATEGORIES[categoryKey];
  if (!meta?.archivable) throw new Error(`Category "${categoryKey}" is not archivable`);

  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) throw new Error(`Category directory not found: ${categoryKey}`);

  const backupDir = join(DATA_DIR, 'backup');
  if (!existsSync(backupDir)) {
    execSync(`mkdir -p "${backupDir}"`, { windowsHide: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const archiveName = `${categoryKey}-${timestamp}.tar.gz`;
  const archivePath = join(backupDir, archiveName);

  // For health data, archive everything older than cutoff (default: 1 year)
  const daysToKeep = options.daysToKeep ?? 365;

  if (categoryKey === 'health') {
    // Archive health files older than threshold
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // Find old files
    const files = await readdir(dirPath).catch(() => []);
    const oldFiles = files.filter(f => f.endsWith('.json') && f.slice(0, 10) < cutoffStr);

    if (oldFiles.length === 0) return { archived: 0, archivePath: null, message: 'No old files to archive' };

    // Create tar of old files
    const fileList = oldFiles.join('\n');
    execSync(`echo "${fileList}" | tar -czf "${archivePath}" -C "${dirPath}" -T -`, {
      windowsHide: true, timeout: 120000
    });

    // Remove archived files
    for (const f of oldFiles) {
      await rm(join(dirPath, f)).catch(() => {});
    }

    return { archived: oldFiles.length, archivePath: relative(process.cwd(), archivePath), size: getDirSize(archivePath) };
  }

  // Generic category: archive entire contents
  const sizeBefore = getDirSize(dirPath);
  execSync(`tar -czf "${archivePath}" -C "${DATA_DIR}" "${categoryKey}"`, {
    windowsHide: true, timeout: 120000
  });

  return {
    archived: countFiles(dirPath),
    archivePath: relative(process.cwd(), archivePath),
    originalSize: sizeBefore,
    archiveSize: getDirSize(archivePath)
  };
}

/**
 * Delete contents of a category (with safety checks)
 */
export async function purgeCategory(categoryKey, options = {}) {
  const meta = CATEGORIES[categoryKey];
  if (!meta?.deletable) throw new Error(`Category "${categoryKey}" is not purgeable`);

  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) throw new Error(`Category directory not found: ${categoryKey}`);

  const sizeBefore = getDirSize(dirPath);
  const filesBefore = countFiles(dirPath);

  if (options.subPath) {
    // Delete a specific subdirectory within the category
    const targetPath = join(dirPath, options.subPath);
    if (!existsSync(targetPath)) throw new Error(`Path not found: ${options.subPath}`);
    if (!targetPath.startsWith(dirPath)) throw new Error('Path traversal not allowed');
    await rm(targetPath, { recursive: true, force: true });
  } else {
    // Clear all contents but keep the directory
    const entries = await readdir(dirPath).catch(() => []);
    for (const entry of entries) {
      await rm(join(dirPath, entry), { recursive: true, force: true });
    }
  }

  const sizeAfter = getDirSize(dirPath);

  return {
    freedBytes: sizeBefore - sizeAfter,
    filesRemoved: filesBefore - countFiles(dirPath),
    category: categoryKey,
    subPath: options.subPath || null
  };
}

/**
 * Get list of existing backups
 */
export async function getBackups() {
  const backupDir = join(DATA_DIR, 'backup');
  if (!existsSync(backupDir)) return [];

  const entries = await readdir(backupDir, { withFileTypes: true }).catch(() => []);
  const backups = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(backupDir, entry.name);
    const fileStat = await stat(fullPath).catch(() => null);
    backups.push({
      name: entry.name,
      size: fileStat?.size || 0,
      created: fileStat?.birthtime?.toISOString() || fileStat?.mtime?.toISOString() || null
    });
  }

  backups.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  return backups;
}

/**
 * Delete a specific backup file
 */
export async function deleteBackup(filename) {
  const backupDir = join(DATA_DIR, 'backup');
  const fullPath = join(backupDir, filename);
  if (!fullPath.startsWith(backupDir)) throw new Error('Path traversal not allowed');
  if (!existsSync(fullPath)) throw new Error(`Backup not found: ${filename}`);
  await rm(fullPath);
  return { deleted: filename };
}
