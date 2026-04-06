/**
 * Obsidian Notes Service
 *
 * Reads/writes Obsidian vaults from configured directories (typically iCloud).
 * Parses markdown, extracts wikilinks, tags, and frontmatter.
 * Notes stay in their original vault directories — PortOS indexes but doesn't copy.
 */

import { readFile, writeFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, relative, basename, dirname, extname } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';

const VAULTS_FILE = join(PATHS.brain, 'obsidian-vaults.json');

const DEFAULT_ICLOUD_OBSIDIAN = join(
  process.env.HOME || '',
  'Library/Mobile Documents/iCloud~md~obsidian/Documents'
);

const SKIP_DIRS = new Set(['.obsidian', '.trash', 'node_modules', '.git']);

// =============================================================================
// VAULT CONFIGURATION
// =============================================================================

export async function getVaults() {
  await ensureDir(PATHS.brain);
  const data = await readJSONFile(VAULTS_FILE, { vaults: [] });
  return data.vaults || [];
}

async function saveVaults(vaults) {
  await ensureDir(PATHS.brain);
  await writeFile(VAULTS_FILE, JSON.stringify({ vaults }, null, 2));
}

export async function addVault({ name, path }) {
  const vaults = await getVaults();

  if (!existsSync(path)) {
    return { error: 'PATH_NOT_FOUND', message: `Directory not found: ${path}` };
  }

  if (vaults.some(v => v.path === path)) {
    return { error: 'DUPLICATE_PATH', message: 'A vault with this path already exists' };
  }

  const vault = {
    id: uuidv4(),
    name: name || basename(path),
    path,
    addedAt: new Date().toISOString()
  };

  vaults.push(vault);
  await saveVaults(vaults);
  console.log(`📓 Added Obsidian vault: ${vault.name} (${path})`);
  return vault;
}

export async function removeVault(id) {
  const vaults = await getVaults();
  const index = vaults.findIndex(v => v.id === id);
  if (index === -1) return false;

  const removed = vaults.splice(index, 1)[0];
  await saveVaults(vaults);
  console.log(`📓 Removed Obsidian vault: ${removed.name}`);
  return true;
}

export async function updateVault(id, updates) {
  const vaults = await getVaults();
  const vault = vaults.find(v => v.id === id);
  if (!vault) return null;

  if (updates.name) vault.name = updates.name;
  if (updates.path) {
    if (!existsSync(updates.path)) {
      return { error: 'PATH_NOT_FOUND', message: `Directory not found: ${updates.path}` };
    }
    vault.path = updates.path;
  }

  await saveVaults(vaults);
  return vault;
}

export async function getVaultById(id) {
  const vaults = await getVaults();
  return vaults.find(v => v.id === id) || null;
}

export async function detectVaults() {
  if (!existsSync(DEFAULT_ICLOUD_OBSIDIAN)) return [];

  const entries = await readdir(DEFAULT_ICLOUD_OBSIDIAN, { withFileTypes: true });
  const detected = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      const vaultPath = join(DEFAULT_ICLOUD_OBSIDIAN, entry.name);
      if (existsSync(join(vaultPath, '.obsidian'))) {
        detected.push({ name: entry.name, path: vaultPath });
      }
    }
  }
  return detected;
}

// =============================================================================
// NOTE SCANNING & READING
// =============================================================================

/**
 * Scan a vault for markdown files. Reads only frontmatter (not full content)
 * for performance. Full content is loaded on individual note reads.
 */
export async function scanVault(vaultId, { folder } = {}) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };
  if (!existsSync(vault.path)) return { error: 'PATH_NOT_FOUND' };

  const notes = [];
  await walkDir(vault.path, vault.path, notes, folder);

  notes.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return { vault, notes, total: notes.length };
}

/**
 * Light scan: reads only file stats and first ~1KB for frontmatter/tags.
 * Skips full content parsing for performance on large vaults.
 */
async function walkDir(rootPath, currentPath, results, folderFilter) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await walkDir(rootPath, fullPath, results, folderFilter);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const relativePath = relative(rootPath, fullPath);
      const noteFolder = dirname(relativePath) === '.' ? '' : dirname(relativePath);

      // Apply folder filter early to skip unnecessary reads
      if (folderFilter && noteFolder !== folderFilter && !noteFolder.startsWith(folderFilter + '/')) {
        continue;
      }

      const stats = await stat(fullPath);

      // Read only first 2KB for frontmatter + inline tags (skip full content)
      const fd = await readFile(fullPath, { encoding: 'utf-8', flag: 'r' });
      const header = fd.length > 2048 ? fd.slice(0, 2048) : fd;
      const { frontmatter, tags } = parseNoteMetadata(header);

      results.push({
        path: relativePath,
        name: basename(entry.name, '.md'),
        folder: noteFolder,
        size: stats.size,
        createdAt: stats.birthtime.toISOString(),
        modifiedAt: stats.mtime.toISOString(),
        tags,
        hasFrontmatter: !!frontmatter
      });
    }
  }
}

export async function getNote(vaultId, notePath, { includeBacklinks = true } = {}) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };

  const fullPath = join(vault.path, notePath);
  if (!fullPath.startsWith(vault.path)) {
    return { error: 'INVALID_PATH', message: 'Path traversal not allowed' };
  }
  if (!existsSync(fullPath)) return { error: 'NOTE_NOT_FOUND' };

  const content = await readFile(fullPath, 'utf-8');
  const stats = await stat(fullPath);
  const { frontmatter, tags, wikilinks, body } = parseNoteMetadata(content);

  const noteName = basename(notePath, '.md');
  const backlinks = includeBacklinks ? await findBacklinks(vault.path, noteName) : [];

  return {
    path: notePath,
    name: noteName,
    content,
    body,
    frontmatter,
    tags,
    wikilinks,
    backlinks,
    size: stats.size,
    createdAt: stats.birthtime.toISOString(),
    modifiedAt: stats.mtime.toISOString()
  };
}

export async function updateNote(vaultId, notePath, content) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };

  const fullPath = join(vault.path, notePath);
  if (!fullPath.startsWith(vault.path)) return { error: 'INVALID_PATH' };
  if (!existsSync(fullPath)) return { error: 'NOTE_NOT_FOUND' };

  await writeFile(fullPath, content, 'utf-8');
  console.log(`📓 Updated note: ${notePath} in vault ${vault.name}`);
  return await getNote(vaultId, notePath, { includeBacklinks: false });
}

export async function createNote(vaultId, notePath, content = '') {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };

  if (!notePath.endsWith('.md')) notePath += '.md';

  const fullPath = join(vault.path, notePath);
  if (!fullPath.startsWith(vault.path)) return { error: 'INVALID_PATH' };
  if (existsSync(fullPath)) {
    return { error: 'NOTE_EXISTS', message: 'A note with this name already exists' };
  }

  await ensureDir(dirname(fullPath));
  await writeFile(fullPath, content, 'utf-8');
  console.log(`📓 Created note: ${notePath} in vault ${vault.name}`);
  return await getNote(vaultId, notePath, { includeBacklinks: false });
}

export async function deleteNote(vaultId, notePath) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };

  const fullPath = join(vault.path, notePath);
  if (!fullPath.startsWith(vault.path)) return { error: 'INVALID_PATH' };
  if (!existsSync(fullPath)) return { error: 'NOTE_NOT_FOUND' };

  await unlink(fullPath);
  console.log(`📓 Deleted note: ${notePath} from vault ${vault.name}`);
  return true;
}

// =============================================================================
// SEARCH
// =============================================================================

export async function searchNotes(vaultId, query) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };
  if (!existsSync(vault.path)) return { error: 'PATH_NOT_FOUND' };

  const results = [];
  const queryLower = query.toLowerCase();
  // Compile regex once for count matching
  const countRe = new RegExp(escapeRegex(queryLower), 'g');
  await searchDir(vault.path, vault.path, queryLower, countRe, results);

  results.sort((a, b) => {
    if (a.titleMatch && !b.titleMatch) return -1;
    if (!a.titleMatch && b.titleMatch) return 1;
    return b.matchCount - a.matchCount;
  });

  return { results, total: results.length, query };
}

async function searchDir(rootPath, currentPath, query, countRe, results) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await searchDir(rootPath, fullPath, query, countRe, results);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await readFile(fullPath, 'utf-8');
      const contentLower = content.toLowerCase();
      const nameLower = basename(entry.name, '.md').toLowerCase();
      const titleMatch = nameLower.includes(query);
      const contentMatch = contentLower.includes(query);

      if (titleMatch || contentMatch) {
        const relativePath = relative(rootPath, fullPath);
        const { tags } = parseNoteMetadata(content);

        const snippets = [];
        if (contentMatch) {
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && snippets.length < 3; i++) {
            if (lines[i].toLowerCase().includes(query)) {
              snippets.push({ line: i + 1, text: lines[i].trim().slice(0, 200) });
            }
          }
        }

        // Reset regex lastIndex before reuse
        countRe.lastIndex = 0;
        results.push({
          path: relativePath,
          name: basename(entry.name, '.md'),
          folder: dirname(relativePath) === '.' ? '' : dirname(relativePath),
          titleMatch,
          matchCount: (contentLower.match(countRe) || []).length,
          snippets,
          tags
        });
      }
    }
  }
}

// =============================================================================
// LINK GRAPH
// =============================================================================

export async function getVaultGraph(vaultId) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };
  if (!existsSync(vault.path)) return { error: 'PATH_NOT_FOUND' };

  const nodes = [];
  const edges = [];
  const noteMap = new Map();

  await collectNotes(vault.path, vault.path, noteMap, nodes);

  // Build case-insensitive lookup for wikilink resolution
  const lowerMap = new Map();
  for (const [name, path] of noteMap) {
    lowerMap.set(name.toLowerCase(), path);
  }

  for (const node of nodes) {
    for (const link of node.wikilinks) {
      const targetPath = lowerMap.get(link.toLowerCase());
      if (targetPath) {
        edges.push({ source: node.path, target: targetPath });
      }
    }
  }

  return {
    nodes: nodes.map(({ path, name, folder, tags }) => ({ path, name, folder, tags })),
    edges,
    totalNodes: nodes.length,
    totalEdges: edges.length
  };
}

async function collectNotes(rootPath, currentPath, noteMap, nodes) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectNotes(rootPath, fullPath, noteMap, nodes);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await readFile(fullPath, 'utf-8');
      const relativePath = relative(rootPath, fullPath);
      const noteName = basename(entry.name, '.md');
      const { tags, wikilinks } = parseNoteMetadata(content);

      noteMap.set(noteName, relativePath);
      nodes.push({
        path: relativePath,
        name: noteName,
        folder: dirname(relativePath) === '.' ? '' : dirname(relativePath),
        tags,
        wikilinks
      });
    }
  }
}

// =============================================================================
// PARSING HELPERS
// =============================================================================

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
const TAG_RE = /(?:^|\s)#([a-zA-Z][a-zA-Z0-9_/-]*)/g;

function parseNoteMetadata(content) {
  let frontmatter = null;
  let body = content;

  if (content.startsWith('---')) {
    const endIndex = content.indexOf('---', 3);
    if (endIndex !== -1) {
      frontmatter = parseSimpleYaml(content.slice(3, endIndex).trim());
      body = content.slice(endIndex + 3).trim();
    }
  }

  // Extract wikilinks
  const wikilinks = [];
  WIKILINK_RE.lastIndex = 0;
  let match;
  while ((match = WIKILINK_RE.exec(body)) !== null) {
    const link = match[1].trim();
    if (!wikilinks.includes(link)) wikilinks.push(link);
  }

  // Extract tags
  const tags = new Set();
  if (frontmatter?.tags) {
    const fmTags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [frontmatter.tags];
    fmTags.forEach(t => tags.add(String(t).replace(/^#/, '')));
  }
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(body)) !== null) {
    tags.add(match[1]);
  }

  return { frontmatter, body, tags: [...tags], wikilinks };
}

function parseSimpleYaml(yamlStr) {
  const result = {};
  const lines = yamlStr.split('\n');
  let currentKey = null;
  let currentList = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    if (trimmed.startsWith('- ') && currentKey && currentList) {
      currentList.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ''));
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const key = trimmed.slice(0, colonIdx).trim();
      const value = trimmed.slice(colonIdx + 1).trim();

      if (!value) {
        currentKey = key;
        currentList = [];
        result[key] = currentList;
      } else {
        currentKey = null;
        currentList = null;
        if (value === 'true') result[key] = true;
        else if (value === 'false') result[key] = false;
        else if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value.slice(1, -1).split(',').map(s => s.trim().replace(/^['"]|['"]$/g, ''));
        } else {
          result[key] = value.replace(/^['"]|['"]$/g, '');
        }
      }
    }
  }

  return result;
}

async function findBacklinks(vaultPath, targetName) {
  const backlinks = [];
  const targetLower = targetName.toLowerCase();
  await findBacklinksInDir(vaultPath, vaultPath, targetLower, backlinks);
  return backlinks;
}

async function findBacklinksInDir(rootPath, currentPath, targetLower, results) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await findBacklinksInDir(rootPath, fullPath, targetLower, results);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await readFile(fullPath, 'utf-8');
      WIKILINK_RE.lastIndex = 0;
      let match;
      while ((match = WIKILINK_RE.exec(content)) !== null) {
        if (match[1].trim().toLowerCase() === targetLower) {
          results.push({
            path: relative(rootPath, fullPath),
            name: basename(entry.name, '.md')
          });
          break;
        }
      }
    }
  }
}

export async function getVaultTags(vaultId) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };
  if (!existsSync(vault.path)) return { error: 'PATH_NOT_FOUND' };

  const tagCounts = new Map();
  await collectTags(vault.path, vault.path, tagCounts);

  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return { tags, total: tags.length };
}

async function collectTags(rootPath, currentPath, tagCounts) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectTags(rootPath, fullPath, tagCounts);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await readFile(fullPath, 'utf-8');
      const { tags } = parseNoteMetadata(content);
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }
  }
}

export async function getVaultFolders(vaultId) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };
  if (!existsSync(vault.path)) return { error: 'PATH_NOT_FOUND' };

  const folders = [];
  await collectFolders(vault.path, vault.path, folders);
  folders.sort();
  return { folders };
}

async function collectFolders(rootPath, currentPath, results) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      const fullPath = join(currentPath, entry.name);
      results.push(relative(rootPath, fullPath));
      await collectFolders(rootPath, fullPath, results);
    }
  }
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
