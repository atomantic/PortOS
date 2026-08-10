/**
 * Obsidian Notes Service
 *
 * Reads/writes Obsidian vaults from configured directories (typically iCloud).
 * Parses markdown, extracts wikilinks, tags, and frontmatter.
 * Notes stay in their original vault directories — PortOS indexes but doesn't copy.
 */

import { writeFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync, realpathSync } from 'fs';
import { join, relative, resolve, basename, dirname, extname, isAbsolute } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { ICLOUD_NOT_MATERIALIZED, isSuspectedDataless, materializeAndWait, readIfMaterialized } from '../lib/icloudFile.js';

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
  await atomicWrite(VAULTS_FILE, { vaults });
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

// Resolve `notePath` against `vault.path` and confirm the result is still
// contained within the vault after symlinks are followed. Returns the
// containable full path or null if the path escapes (including via symlinks,
// prefix-match tricks like `/vault-evil`, or absolute/UNC inputs). When the
// target doesn't exist yet (createNote), realpath the parent directory so a
// new file path can still be validated.
function resolveVaultPath(vault, notePath) {
  const rootResolved = resolve(vault.path);
  const rootReal = (() => {
    try { return realpathSync(rootResolved); } catch { return rootResolved; }
  })();
  const fullPath = resolve(join(vault.path, notePath));
  const real = (() => {
    try { return realpathSync(fullPath); } catch {
      // Non-existent target: realpath the parent (which MUST already exist
      // for the path to be meaningful) and re-append the basename.
      try {
        const parentReal = realpathSync(dirname(fullPath));
        return join(parentReal, basename(fullPath));
      } catch {
        return fullPath;
      }
    }
  })();
  const rel = relative(rootReal, real);
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return real;
  return null;
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

// The default Obsidian vault location is an iCloud ubiquity container
// (DEFAULT_ICLOUD_OBSIDIAN above), so every note read here can hit a file macOS
// has evicted to the cloud. A plain `readFile` on an evicted file BLOCKS
// forever in the kernel and strands a libuv threadpool thread — and a vault
// walk fires one read per note, so a single evicted vault can exhaust the whole
// pool and take the server's filesystem access (including the UI bundle) down
// with it. See server/lib/icloudFile.js.
//
// Returns `null` for an evicted note so each caller can skip it and degrade to
// partial results, rather than failing the whole scan/search. Every other error
// still propagates unchanged.
async function readNoteContent(fullPath, skipped) {
  return readIfMaterialized(fullPath, { label: 'Obsidian note' }).catch((err) => {
    if (err.code === ICLOUD_NOT_MATERIALIZED) {
      console.warn(`⚠️ Obsidian note evicted from local storage; skipping: ${fullPath}`);
      if (skipped) skipped.count += 1;
      return null;
    }
    throw err;
  });
}

// A vault-wide reader that silently drops evicted notes would report "no results"
// for a query whose answer is sitting in an un-downloaded note — the exact
// absent-vs-unavailable collapse the project forbids. Each public reader below
// therefore carries its own tally and reports `skippedUnavailable` alongside its
// results, so the UI can say "N notes not downloaded yet" instead of "none".
const newSkipTally = () => ({ count: 0 });

/**
 * Scan a vault for markdown files. Reads only frontmatter (not full content)
 * for performance. Full content is loaded on individual note reads.
 */
export async function scanVault(vaultId, { folder } = {}) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };
  if (!existsSync(vault.path)) return { error: 'PATH_NOT_FOUND' };

  const notes = [];
  const skipped = newSkipTally();
  await walkDir(vault.path, vault.path, notes, folder, skipped);

  notes.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  return { vault, notes, total: notes.length, skippedUnavailable: skipped.count };
}

/**
 * Light scan: reads only file stats and first ~1KB for frontmatter/tags.
 * Skips full content parsing for performance on large vaults.
 */
async function walkDir(rootPath, currentPath, results, folderFilter, skipped) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await walkDir(rootPath, fullPath, results, folderFilter, skipped);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const relativePath = relative(rootPath, fullPath);
      const noteFolder = dirname(relativePath) === '.' ? '' : dirname(relativePath);

      // Apply folder filter early to skip unnecessary reads
      if (folderFilter && noteFolder !== folderFilter && !noteFolder.startsWith(folderFilter + '/')) {
        continue;
      }

      const stats = await stat(fullPath);

      // Read only first 2KB for frontmatter + inline tags (skip full content)
      const fd = await readNoteContent(fullPath, skipped);
      if (fd === null) continue;
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

  const fullPath = resolveVaultPath(vault, notePath);
  if (!fullPath) {
    return { error: 'INVALID_PATH', message: 'Path traversal not allowed' };
  }
  if (!existsSync(fullPath)) return { error: 'NOTE_NOT_FOUND' };

  const content = await readNoteContent(fullPath);
  // Evicted, not missing — a distinct code so the UI can say "iCloud hasn't
  // downloaded this note yet" instead of claiming it doesn't exist. The read was
  // never issued, and a background `brctl download` is already in flight.
  if (content === null) {
    return { error: 'NOTE_EVICTED', message: 'This note is stored in iCloud and has not been downloaded to this Mac yet. A download was requested — try again shortly.' };
  }
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

  const fullPath = resolveVaultPath(vault, notePath);
  if (!fullPath) return { error: 'INVALID_PATH' };
  if (!existsSync(fullPath)) return { error: 'NOTE_NOT_FOUND' };

  // Overwriting an EVICTED note would block exactly like reading one — measured,
  // not assumed: `writeFile`'s O_TRUNC does NOT skip materialization (822ms
  // dataless vs 1ms materialized for the same call; see the syscall table in
  // server/lib/icloudFile.js). Discarding every byte first is intuitively enough
  // to make the download pointless, and the kernel disagrees.
  //
  // This matters beyond "a user clicked save": updateNote is reached from
  // BACKGROUND mirrors via upsertNote — the Brain daily-log mirror and YouTube
  // ingest — so a wedged iCloud could strand libuv threadpool slots with no user
  // in the loop, which is the whole-UI outage #3704 fixed on the read side.
  //
  // A write must not silently skip, so unlike the read paths this materializes
  // and WAITS (bounded, in a child process — cancellable, which the kernel write
  // is not) rather than fire-and-forget. brctl exit 0 only means the download was
  // accepted, so re-screen before trusting it and refuse if it's still dataless.
  if (await isSuspectedDataless(fullPath)) {
    await materializeAndWait(fullPath, { label: 'Obsidian note' });
    if (await isSuspectedDataless(fullPath)) {
      return {
        error: 'NOTE_EVICTED',
        message: 'This note is stored in iCloud and has not been downloaded to this Mac yet. A download was requested — try again shortly.'
      };
    }
  }

  await writeFile(fullPath, content, 'utf-8');
  console.log(`📓 Updated note: ${notePath} in vault ${vault.name}`);
  return await getNote(vaultId, notePath, { includeBacklinks: false });
}

export async function createNote(vaultId, notePath, content = '') {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };

  if (!notePath.endsWith('.md')) notePath += '.md';

  // For a new file the target doesn't exist yet — resolveVaultPath realpaths
  // the parent directory (which must exist) to still catch symlink escapes.
  await ensureDir(dirname(join(vault.path, notePath)));
  const fullPath = resolveVaultPath(vault, notePath);
  if (!fullPath) return { error: 'INVALID_PATH' };
  if (existsSync(fullPath)) {
    return { error: 'NOTE_EXISTS', message: 'A note with this name already exists' };
  }

  // No dataless screen here, deliberately (#3706): the `existsSync` above means
  // this only ever writes a file that does NOT exist, and a path with no file at
  // it cannot be a dataless vnode — there is nothing offloaded to materialize.
  // The overwrite case is `updateNote`, which is guarded. Don't add a screen here
  // "for symmetry"; it would cost a stat per created note and can never fire.
  //
  // This covers the modern APFS representation only. The LEGACY representation —
  // an evicted file replaced by a sibling `.<name>.md.icloud` placeholder, which
  // `mortalLoomStore` still checks for (`icloudPlaceholderPath`) — is NOT handled:
  // `existsSync(fullPath)` is false for a placeholder-shadowed note, so this
  // creates a fresh file beside the placeholder rather than refusing. Tracked
  // separately; it predates #3706 and needs its own decision about whether vaults
  // ever see placeholders on current macOS.
  await writeFile(fullPath, content, 'utf-8');
  console.log(`📓 Created note: ${notePath} in vault ${vault.name}`);
  return await getNote(vaultId, notePath, { includeBacklinks: false });
}

/**
 * Write a note whether or not it already exists.
 *
 * `createNote` refuses an existing file and `updateNote` refuses a missing one,
 * so every mirror-a-record-into-the-vault caller has to try one and fall back to
 * the other. That ordering rule is a property of THIS adapter, not of any
 * caller, so it lives here — the Daily Log mirror and the YouTube-ingest
 * transcript mirror both go through this.
 *
 * CREATE first, then update on `NOTE_EXISTS` — not the other way round. Only
 * `createNote` ensures the note's parent folder, and `resolveVaultPath` cannot
 * containment-check a path whose parent does not exist yet: it falls back to the
 * un-realpath'd path, which fails the check against the realpath'd vault root
 * whenever the vault is reached through a symlink (`/var` → `/private/var` on
 * macOS, and any vault the user reaches via a symlinked home or mount). Trying
 * `updateNote` first therefore reports `INVALID_PATH` — not `NOTE_NOT_FOUND` —
 * for the very first note written into a new subfolder, and a caller keyed on
 * `NOTE_NOT_FOUND` silently mirrors nothing. Creating first sidesteps it: the
 * folder is ensured before the path is resolved, and by the time `updateNote`
 * runs the parent provably exists.
 *
 * Also swallows the "vault configured but its folder is gone" case (an unplugged
 * external drive, an iCloud container not yet materialized) as a no-op rather
 * than an error: a mirror is best-effort by nature, and the record it mirrors is
 * already stored in PortOS.
 *
 * @returns {Promise<string|null>} the note path on success, null when the write
 *   was skipped or the adapter reported an error.
 */
export async function upsertNote(vaultId, notePath, content) {
  const vault = await getVaultById(vaultId);
  if (!vault || !existsSync(vault.path)) return null;

  const created = await createNote(vaultId, notePath, content);
  if (!created?.error) return notePath;
  if (created.error !== 'NOTE_EXISTS') return null;

  const updated = await updateNote(vaultId, notePath, content);
  return updated?.error ? null : notePath;
}

export async function deleteNote(vaultId, notePath) {
  const vault = await getVaultById(vaultId);
  if (!vault) return { error: 'VAULT_NOT_FOUND' };

  const fullPath = resolveVaultPath(vault, notePath);
  if (!fullPath) return { error: 'INVALID_PATH' };
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
  const skipped = newSkipTally();
  await searchDir(vault.path, vault.path, queryLower, countRe, results, skipped);

  results.sort((a, b) => {
    if (a.titleMatch && !b.titleMatch) return -1;
    if (!a.titleMatch && b.titleMatch) return 1;
    return b.matchCount - a.matchCount;
  });

  return { results, total: results.length, query, skippedUnavailable: skipped.count };
}

async function searchDir(rootPath, currentPath, query, countRe, results, skipped) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  // Kick off this directory's markdown reads concurrently (the disk-latency
  // win), but keep the ORIGINAL depth-first walk order when pushing results:
  // iterate entries in readdir order and recurse into a subdir at the exact
  // point the sequential version would have, so result ordering is unchanged.
  const contentReads = new Map();
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && extname(entry.name) === '.md') {
      contentReads.set(entry.name, readNoteContent(join(currentPath, entry.name), skipped));
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await searchDir(rootPath, fullPath, query, countRe, results, skipped);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await contentReads.get(entry.name);
      if (content === null) continue;   // evicted from iCloud — skip, don't block
      const contentLower = content.toLowerCase();
      const nameLower = basename(entry.name, '.md').toLowerCase();
      const titleMatch = nameLower.includes(query);
      const contentMatch = contentLower.includes(query);
      if (!titleMatch && !contentMatch) continue;

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

  const skipped = newSkipTally();
  await collectNotes(vault.path, vault.path, noteMap, nodes, skipped);

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
    totalEdges: edges.length,
    // Evicted notes are missing from the graph entirely — and so is every edge
    // into them, which would otherwise render a wrong topology as authoritative.
    skippedUnavailable: skipped.count
  };
}

async function collectNotes(rootPath, currentPath, noteMap, nodes, skipped) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  // Read this directory's markdown files concurrently, but apply them in the
  // ORIGINAL depth-first entry order (interleaving subdir recursion at the same
  // point). noteMap is last-write-wins, so preserving the traversal order keeps
  // duplicate-basename wikilink resolution identical to the sequential version.
  const contentReads = new Map();
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    if (entry.isFile() && extname(entry.name) === '.md') {
      contentReads.set(entry.name, readNoteContent(join(currentPath, entry.name), skipped));
    }
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectNotes(rootPath, fullPath, noteMap, nodes, skipped);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await contentReads.get(entry.name);
      if (content === null) continue;   // evicted from iCloud — skip, don't block
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
      // findBacklinks is supplementary to a note that already loaded, so an
      // evicted neighbour is logged by readNoteContent but not surfaced as a
      // count — the note itself is not misreported as empty.
      const content = await readNoteContent(fullPath);
      if (content === null) continue;   // evicted from iCloud — skip, don't block
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
  const skipped = newSkipTally();
  await collectTags(vault.path, vault.path, tagCounts, skipped);

  const tags = [...tagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);

  return { tags, total: tags.length, skippedUnavailable: skipped.count };
}

async function collectTags(rootPath, currentPath, tagCounts, skipped) {
  const entries = await readdir(currentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue;
    const fullPath = join(currentPath, entry.name);

    if (entry.isDirectory()) {
      await collectTags(rootPath, fullPath, tagCounts, skipped);
    } else if (entry.isFile() && extname(entry.name) === '.md') {
      const content = await readNoteContent(fullPath, skipped);
      if (content === null) continue;   // evicted from iCloud — skip, don't block
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
