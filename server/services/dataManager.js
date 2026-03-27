import { readdir, stat, rm, mkdir, writeFile as fsWriteFile } from 'fs/promises';
import { join, relative } from 'path';
import { existsSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);
const DATA_DIR = join(process.cwd(), 'data');

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

// Validate category key contains only safe characters
const SAFE_NAME = /^[a-z0-9_-]+$/;

async function getDirSizeAndCount(dirPath) {
  if (!existsSync(dirPath)) return { size: 0, fileCount: 0 };
  const [duOut, findOut] = await Promise.all([
    execAsync(`du -sk "${dirPath}" 2>/dev/null || echo "0"`, { windowsHide: true }).then(r => r.stdout.trim()),
    execAsync(`find "${dirPath}" -type f 2>/dev/null | wc -l`, { windowsHide: true }).then(r => r.stdout.trim())
  ]);
  const kb = parseInt(duOut.split('\t')[0], 10) || 0;
  return { size: kb * 1024, fileCount: parseInt(findOut, 10) || 0 };
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
    const meta = CATEGORIES[d.name] || { label: d.name, description: 'Unknown category', archivable: false, deletable: false };
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
  const meta = CATEGORIES[categoryKey] || { label: categoryKey, archivable: false, deletable: false };

  return { key: categoryKey, ...meta, totalSize, items };
}

export async function archiveCategory(categoryKey, options = {}) {
  if (!SAFE_NAME.test(categoryKey)) throw new Error('Invalid category name');
  const meta = CATEGORIES[categoryKey];
  if (!meta?.archivable) throw new Error(`Category "${categoryKey}" is not archivable`);

  const dirPath = join(DATA_DIR, categoryKey);
  if (!existsSync(dirPath)) throw new Error(`Category directory not found: ${categoryKey}`);

  const backupDir = join(DATA_DIR, 'backup');
  await mkdir(backupDir, { recursive: true });

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
    await execAsync(`tar -czf "${archivePath}" -C "${dirPath}" -T "${listPath}"`, { timeout: 120000, windowsHide: true });
    await rm(listPath).catch(() => {});

    for (const f of oldFiles) {
      await rm(join(dirPath, f)).catch(() => {});
    }

    const archiveStat = await stat(archivePath).catch(() => null);
    return { archived: oldFiles.length, archivePath: relative(process.cwd(), archivePath), size: archiveStat?.size || 0 };
  }

  // Generic: archive entire category contents
  await execAsync(`tar -czf "${archivePath}" -C "${DATA_DIR}" "${categoryKey}"`, { timeout: 120000, windowsHide: true });
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
    if (!SAFE_NAME.test(options.subPath.replace(/\//g, ''))) throw new Error('Invalid subpath');
    const targetPath = join(dirPath, options.subPath);
    if (!targetPath.startsWith(dirPath)) throw new Error('Path traversal not allowed');
    await rm(targetPath, { recursive: true, force: true });
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

export async function deleteBackup(filename) {
  if (!SAFE_NAME.test(filename.replace(/[.]/g, ''))) throw new Error('Invalid filename');
  const backupDir = join(DATA_DIR, 'backup');
  const fullPath = join(backupDir, filename);
  if (!fullPath.startsWith(backupDir)) throw new Error('Path traversal not allowed');
  await rm(fullPath);
  return { deleted: filename };
}
