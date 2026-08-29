/**
 * Explicit IdeaLoom <-> Obsidian exchange.
 *
 * IdeaLoom notes are deliberately parsed here instead of through the generic
 * Obsidian YAML helper. The generic reader is intentionally forgiving; this
 * boundary must preserve escaped prompt/title values and reject ambiguous
 * list documents before they enter the local list store.
 */

import { createHash } from 'crypto';
import { existsSync } from 'fs';
import { join } from 'path';
import * as obsidian from './obsidian.js';
import * as ideaLoomLists from './idealoomLists.js';
import { ideaLoomListInputSchema } from '../lib/brainValidation.js';

export const IDEA_LOOM_FOLDER = 'Idea Loom';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NUMBERED_IDEA_RE = /^(\d+)\.\s+(.+)$/;

const RESULT_KEYS = ['imported', 'exported', 'skipped', 'conflicted', 'missing', 'malformed', 'unavailable', 'failed'];

const newResult = () => {
  const counts = Object.fromEntries(RESULT_KEYS.map((key) => [key, 0]));
  return {
    ...counts,
    counts,
    details: Object.fromEntries(RESULT_KEYS.map((key) => [key, []])),
  };
};

const addResult = (result, kind, detail) => {
  result[kind] += 1;
  result.counts[kind] += 1;
  result.details[kind].push(detail);
};

const hashContent = (content) => createHash('sha256').update(content, 'utf8').digest('hex');

const isIsoDate = (value) => typeof value === 'string'
  && value.length > 0
  && !Number.isNaN(Date.parse(value));

const latestSyncTime = (sync) => [sync?.lastImportedAt, sync?.lastExportedAt]
  .filter(isIsoDate)
  .reduce((latest, value) => (!latest || Date.parse(value) > Date.parse(latest) ? value : latest), null);

const hasLocalChanges = (list) => {
  const lastSync = latestSyncTime(list.sync);
  return !lastSync || Date.parse(list.updatedAt) > Date.parse(lastSync);
};

const decodeScalar = (value) => {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    const source = trimmed.slice(1, -1);
    let decoded = '';
    for (let index = 0; index < source.length; index += 1) {
      if (source[index] !== '\\') {
        decoded += source[index];
        continue;
      }
      index += 1;
      const escape = source[index];
      const escapes = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (escape === 'u' && /^[0-9a-f]{4}$/i.test(source.slice(index + 1, index + 5))) {
        decoded += String.fromCharCode(Number.parseInt(source.slice(index + 1, index + 5), 16));
        index += 4;
      } else if (escape in escapes) {
        decoded += escapes[escape];
      } else {
        return null;
      }
    }
    return decoded;
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed || null;
};

const parseFrontmatter = (lines) => {
  if (lines[0] !== '---') return { error: 'missing frontmatter' };
  const end = lines.findIndex((line, index) => index > 0 && line === '---');
  if (end < 0) return { error: 'unterminated frontmatter' };

  const values = {};
  for (let index = 1; index < end; index += 1) {
    const line = lines[index];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z][A-Za-z0-9_-]*):(?:\s*)(.*)$/.exec(line);
    if (!match) return { error: `invalid frontmatter line ${index + 1}` };
    const [, indent, key, rawValue] = match;
    if (key === 'tags' && !rawValue.trim()) {
      const tags = [];
      let tagIndex = index + 1;
      while (tagIndex < end && /^\s+-\s+/.test(lines[tagIndex])) {
        const tag = decodeScalar(lines[tagIndex].replace(/^\s+-\s+/, ''));
        if (typeof tag !== 'string' || !tag) return { error: `invalid tag at line ${tagIndex + 1}` };
        tags.push(tag.replace(/^#/, ''));
        tagIndex += 1;
      }
      values.tags = tags;
      index = tagIndex - 1;
      continue;
    }
    if (indent) return { error: `unexpected indentation at line ${index + 1}` };
    if (!rawValue.trim()) {
      let propertyIndex = index + 1;
      const propertyValues = [];
      while (propertyIndex < end && /^\s+-\s+/.test(lines[propertyIndex])) {
        const propertyValue = decodeScalar(lines[propertyIndex].replace(/^\s+-\s+/, ''));
        if (propertyValue === null) return { error: `invalid ${key} property at line ${propertyIndex + 1}` };
        propertyValues.push(propertyValue);
        propertyIndex += 1;
      }
      values[key] = propertyValues.length ? propertyValues : '';
      index = propertyIndex - 1;
      continue;
    }
    if (key === 'tags' && rawValue.trim().startsWith('[') && rawValue.trim().endsWith(']')) {
      const inner = rawValue.trim().slice(1, -1).trim();
      values.tags = inner ? inner.split(',').map((entry) => decodeScalar(entry)).filter(Boolean).map((tag) => tag.replace(/^#/, '')) : [];
      continue;
    }
    if (key === 'tags') {
      const tag = decodeScalar(rawValue);
      if (tag === null) return { error: `invalid tags at line ${index + 1}` };
      values.tags = [tag.replace(/^#/, '')];
      continue;
    }
    const value = decodeScalar(rawValue);
    if (value === null) return { error: `empty frontmatter value for ${key}` };
    values[key] = value;
  }
  return { end, values };
};

const parseBody = (lines) => {
  const headingIndex = lines.findIndex((line) => /^#{1,6}\s+\S/.test(line));
  if (headingIndex < 0) return { error: 'missing prompt heading' };

  let prompt = lines[headingIndex].replace(/^#{1,6}\s+/, '').trim();
  let cursor = headingIndex + 1;
  if (prompt.toLowerCase() === 'prompt') {
    let nextContentIndex = cursor;
    while (nextContentIndex < lines.length && !lines[nextContentIndex].trim()) nextContentIndex += 1;
    const nextContent = lines[nextContentIndex]?.trim();
    // IdeaLoom sometimes uses a literal "Prompt" heading. Do not consume the
    // first numbered idea as prompt text in that valid, empty-help shape.
    if (nextContent && !nextContent.startsWith('#') && !NUMBERED_IDEA_RE.test(nextContent)) {
      prompt = nextContent;
      cursor = nextContentIndex + 1;
    }
  }
  if (!prompt) return { error: 'missing prompt text' };

  const helpLines = [];
  const ideas = [];
  let sawIdea = false;
  let section = 'legacy';
  for (; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (!line.trim()) {
      if (!sawIdea) helpLines.push('');
      continue;
    }
    const heading = line.trim();
    if (/^#{1,6}\s+help\s*:?$/i.test(heading)) {
      section = 'help';
      continue;
    }
    if (/^#{1,6}\s+ideas\s*:?$/i.test(heading)) {
      section = 'ideas';
      continue;
    }
    const match = NUMBERED_IDEA_RE.exec(line.trim());
    if (section === 'help') {
      helpLines.push(line);
      continue;
    }
    if (!match) {
      if (sawIdea || section === 'ideas') return { error: `invalid numbered idea at line ${cursor + 1}` };
      helpLines.push(line);
      continue;
    }
    section = 'ideas';
    sawIdea = true;
    const expected = ideas.length + 1;
    if (Number(match[1]) !== expected || !match[2].trim()) {
      return { error: `idea numbering must be dense starting at 1 (line ${cursor + 1})` };
    }
    ideas.push(match[2].trim());
  }

  return { prompt, help: helpLines.join('\n').trim(), ideas };
};

/** Parse the supported IdeaLoom Markdown shape into a local list document. */
export function parseIdeaLoomMarkdown(content) {
  if (typeof content !== 'string') return { ok: false, error: 'content is not text' };
  const lines = content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const frontmatter = parseFrontmatter(lines);
  if (frontmatter.error) return { ok: false, error: frontmatter.error };
  const { values } = frontmatter;
  const id = values.id || values.uuid;
  const createdAt = values.created || values.createdAt;
  const updatedAt = values.modified || values.updatedAt;
  if (!UUID_RE.test(id || '')) return { ok: false, error: 'missing or invalid UUID' };
  if (!['draft', 'completed'].includes(values.status)) return { ok: false, error: 'unsupported status' };
  if (!values.title || !values.category || !isIsoDate(createdAt) || !isIsoDate(updatedAt)) {
    return { ok: false, error: 'missing title, category, created, or modified metadata' };
  }

  const body = parseBody(lines.slice(frontmatter.end + 1));
  if (body.error) return { ok: false, error: body.error };
  if (!Array.isArray(values.tags) || !values.tags.some((tag) => tag.toLowerCase() === 'idea-loom')) {
    return { ok: false, error: 'missing idea-loom tag' };
  }
  const validated = ideaLoomListInputSchema.safeParse({
    prompt: body.prompt,
    title: values.title,
    category: values.category,
    status: values.status,
    help: body.help || undefined,
    ideas: body.ideas,
  });
  if (!validated.success) return { ok: false, error: 'list exceeds supported limits' };
  return {
    ok: true,
    list: {
      id,
      prompt: body.prompt,
      title: values.title,
      category: values.category,
      status: values.status,
      ...(body.help ? { help: body.help } : {}),
      ideas: body.ideas,
      createdAt,
      updatedAt,
      tags: Array.isArray(values.tags) ? values.tags : [],
    },
  };
}

const yamlString = (value) => JSON.stringify(String(value));

/** Render a local list in the stable Markdown shape consumed by IdeaLoom. */
export function renderIdeaLoomMarkdown(list) {
  const lines = [
    '---',
    `id: ${yamlString(list.id)}`,
    `title: ${yamlString(list.title)}`,
    `category: ${yamlString(list.category)}`,
    `status: ${yamlString(list.status)}`,
    `created: ${yamlString(list.createdAt)}`,
    `modified: ${yamlString(list.updatedAt)}`,
    'tags:',
    '  - "idea-loom"',
    '---',
    `# ${String(list.prompt).replace(/[\r\n]+/g, ' ').trim()}`,
  ];
  if (list.help?.trim()) lines.push('', '## Help', String(list.help));
  if (list.ideas?.length) {
    lines.push('', '## Ideas', ...list.ideas.map((idea, index) => `${index + 1}. ${String(idea).replace(/[\r\n]+/g, ' ').trim()}`));
  }
  return `${lines.join('\n')}\n`;
}

const slugify = (value) => String(value || 'list')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '-')
  .replace(/^-+|-+$/g, '')
  .slice(0, 80) || 'list';

const datePart = (value) => {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString().slice(0, 10) : parsed.toISOString().slice(0, 10);
};

const generatedNotePath = (list, suffix = '') =>
  `${IDEA_LOOM_FOLDER}/${datePart(list.createdAt)}-${slugify(list.title)}${suffix}.md`;

const configuredExchange = async () => {
  const settings = await ideaLoomLists.getSettings();
  if (!settings.enabled) return { result: newResult(), reason: 'integration-disabled' };
  if (!settings.obsidianVaultId) return { result: newResult(), reason: 'vault-not-configured' };
  const vault = await obsidian.getVaultById(settings.obsidianVaultId);
  if (!vault) {
    return { result: newResult(), reason: 'vault-not-found' };
  }
  if (!existsSync(vault.path)) {
    return { result: newResult(), reason: 'path-not-found' };
  }
  return { settings, vault };
};

const withReason = (result, reason) => {
  addResult(result, reason === 'integration-disabled' || reason === 'vault-not-configured' ? 'skipped' : 'unavailable', { reason });
  return result;
};

/** Import valid notes from the configured Idea Loom folder. */
export async function importFromObsidian() {
  const exchange = await configuredExchange();
  if (!exchange.vault) return withReason(exchange.result, exchange.reason);
  const scan = await obsidian.scanVault(exchange.settings.obsidianVaultId, { folder: IDEA_LOOM_FOLDER });
  if (scan.error) return withReason(newResult(), scan.error);
  if (!existsSync(join(exchange.vault.path, IDEA_LOOM_FOLDER))) {
    return withReason(newResult(), 'folder-not-found');
  }
  const result = newResult();
  const unavailable = scan.skippedUnavailable || 0;
  for (let index = 0; index < unavailable; index += 1) addResult(result, 'unavailable', { reason: 'note-unavailable' });

  const loaded = await Promise.allSettled(scan.notes.map((note) =>
    obsidian.getNote(exchange.settings.obsidianVaultId, note.path, { includeBacklinks: false })));
  const parsedNotes = [];
  loaded.forEach((entry, index) => {
    const note = scan.notes[index];
    if (entry.status === 'rejected') {
      addResult(result, 'failed', { path: note.path, reason: entry.reason?.message || 'read failed' });
    } else if (entry.value?.error === 'NOTE_EVICTED') {
      addResult(result, 'unavailable', { path: note.path, reason: 'note-unavailable' });
    } else if (entry.value?.error) {
      addResult(result, 'failed', { path: note.path, reason: entry.value.error });
    } else {
      const parsed = parseIdeaLoomMarkdown(entry.value.content);
      if (!parsed.ok) addResult(result, 'malformed', { path: note.path, reason: parsed.error });
      else parsedNotes.push({ ...parsed.list, notePath: note.path, contentHash: hashContent(entry.value.content) });
    }
  });

  const byId = new Map();
  parsedNotes.forEach((note) => {
    const entries = byId.get(note.id) || [];
    entries.push(note);
    byId.set(note.id, entries);
  });
  const importable = [];
  for (const entries of byId.values()) {
    if (entries.length > 1) {
      entries.forEach((note) => addResult(result, 'skipped', { path: note.notePath, reason: 'duplicate-id', id: note.id }));
      continue;
    }
    importable.push(entries[0]);
  }
  const imports = await Promise.allSettled(importable.map(async (note) => {
    const existing = await ideaLoomLists.getList(note.id);
    if (existing?.sync?.notePath === note.notePath && existing.sync?.lastKnownContentHash === note.contentHash) {
      return { kind: 'skipped', path: note.notePath, reason: 'unchanged', id: note.id };
    }
    if (existing?.sync?.lastKnownContentHash
      && existing.sync.lastKnownContentHash !== note.contentHash
      && hasLocalChanges(existing)) {
      return { kind: 'conflicted', path: note.notePath, reason: 'both-sides-changed', id: note.id };
    }
    await ideaLoomLists.upsertImportedList(note.id, {
      prompt: note.prompt,
      title: note.title,
      category: note.category,
      status: note.status,
      help: note.help || '',
      ideas: note.ideas,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      sync: {
        notePath: note.notePath,
        lastKnownContentHash: note.contentHash,
        lastImportedAt: new Date().toISOString(),
      },
    });
    return { kind: 'imported', path: note.notePath, id: note.id, action: existing ? 'updated' : 'created' };
  }));
  imports.forEach((entry, index) => {
    const note = importable[index];
    if (entry.status === 'rejected') addResult(result, 'failed', { path: note.notePath, id: note.id, reason: entry.reason?.message || 'import failed' });
    else addResult(result, entry.value.kind, entry.value);
  });
  await reportDeletedNotes(exchange.vault.path, result);
  return result;
}

/**
 * Surface previously-exchanged lists whose vault note has been deleted.
 *
 * The deletion is REPORTED, never acted on: the local record is kept so the
 * user can decide between deleting the list and recovering the note through an
 * explicit sync. `existsSync` is the right probe rather than the scan result —
 * an iCloud-evicted note is still a file on disk, and reporting an
 * un-downloaded note as deleted would invite exactly the destructive recovery
 * this outcome exists to gate.
 */
const reportDeletedNotes = async (vaultPath, result) => {
  const lists = await ideaLoomLists.listLists();
  lists.forEach((list) => {
    const notePath = list.sync?.notePath;
    if (!notePath || !list.sync?.lastKnownContentHash) return;
    if (existsSync(join(vaultPath, notePath))) return;
    addResult(result, 'missing', { id: list.id, path: notePath, reason: 'note-deleted-externally' });
  });
}

const writeNote = async (vaultId, notePath, content, { allowCreate = true } = {}) => {
  const existing = await obsidian.getNote(vaultId, notePath, { includeBacklinks: false });
  if (existing?.error === 'NOTE_EVICTED') return { kind: 'unavailable', reason: 'note-unavailable' };
  if (existing?.error && existing.error !== 'NOTE_NOT_FOUND') return { kind: 'failed', reason: existing.error };
  const parsedExisting = existing?.content ? parseIdeaLoomMarkdown(existing.content) : null;
  if (parsedExisting?.ok && parsedExisting.list.id !== undefined) {
    return { kind: 'existing', id: parsedExisting.list.id, content: existing.content };
  }
  if (existing?.content) return { kind: 'existing', id: null };
  // The note is absent. Writing it is a CREATE, which the caller must opt into:
  // for a list that has already been exchanged, absence means the user deleted
  // the note, and recreating it would resurrect data they removed on purpose.
  if (!allowCreate) return { kind: 'missing', reason: 'note-deleted-externally' };
  const created = await obsidian.createNote(vaultId, notePath, content);
  if (!created?.error) return { kind: 'written' };
  if (created.error === 'NOTE_EVICTED') return { kind: 'unavailable', reason: 'note-unavailable' };
  return { kind: 'failed', reason: created.error };
};

/**
 * Export one local list, preserving an imported note path forever.
 *
 * `recreateMissing` is the explicit, user-directed recovery switch. Without it
 * a list whose note has been deleted in the vault reports `missing` and writes
 * nothing — automatic sync must never resurrect a note the user removed.
 */
const exportOne = async (vaultId, list, { recreateMissing = false } = {}) => {
  const content = renderIdeaLoomMarkdown(list);
  const importedPath = list.sync?.notePath;
  const previouslyExchanged = Boolean(importedPath && list.sync?.lastKnownContentHash);
  const allowCreate = !previouslyExchanged || recreateMissing;
  let notePath = importedPath || generatedNotePath(list);
  let pathResult = await writeNote(vaultId, notePath, content, { allowCreate });
  if (pathResult.kind === 'missing') return { ...pathResult, id: list.id, notePath };
  if (!importedPath && pathResult.kind === 'existing' && pathResult.id !== list.id) {
    let suffix = `-${list.id.slice(0, 8)}`;
    notePath = generatedNotePath(list, suffix);
    pathResult = await writeNote(vaultId, notePath, content);
  }
  if (pathResult.kind === 'existing') {
    if (pathResult.id !== list.id) return { kind: 'failed', reason: 'note-path-owned-by-another-list', notePath };
    const remoteChanged = hashContent(pathResult.content) !== list.sync?.lastKnownContentHash;
    const localChanged = hasLocalChanges(list);
    if (remoteChanged && localChanged) return { kind: 'conflicted', reason: 'both-sides-changed', notePath };
    if (remoteChanged) return { kind: 'skipped', reason: 'external-change', notePath };
    // The note already reads exactly as this list renders. Writing it anyway is
    // what turns a just-imported list into an export, and that export into the
    // next import's "changed" note — so a no-op write is skipped, not repeated.
    if (hashContent(pathResult.content) === hashContent(content)) {
      return { kind: 'skipped', reason: 'unchanged', notePath, id: list.id };
    }
    const updated = await obsidian.updateNote(vaultId, notePath, content);
    if (updated?.error === 'NOTE_EVICTED') return { kind: 'unavailable', reason: 'note-unavailable', notePath };
    if (updated?.error) return { kind: 'failed', reason: updated.error, notePath };
  } else if (pathResult.kind !== 'written') {
    return { ...pathResult, notePath };
  }
  await ideaLoomLists.updateSyncMetadata(list.id, {
    notePath,
    lastKnownContentHash: hashContent(content),
    lastExportedAt: new Date().toISOString(),
  });
  return { kind: 'exported', id: list.id, notePath };
};

/**
 * Explicitly export all lists, or one selected list, to the configured vault.
 *
 * Automatic sync calls this with the defaults, so it can never delete or
 * recreate a vault note; `recreateMissing` is only ever set by an explicit
 * user-directed recovery request.
 */
export async function exportToObsidian({ listId, recreateMissing = false } = {}) {
  const exchange = await configuredExchange();
  if (!exchange.vault) return withReason(exchange.result, exchange.reason);
  const result = newResult();
  const lists = await ideaLoomLists.listLists();
  const selected = listId ? lists.filter((list) => list.id === listId) : lists;
  if (listId && !selected.length) {
    addResult(result, 'failed', { id: listId, reason: 'list-not-found' });
    return result;
  }
  // Path allocation checks the vault before writing. Keep exports sequential so
  // two lists with the same generated date/title cannot choose the same path.
  for (const list of selected) {
    const [entry] = await Promise.allSettled([exportOne(exchange.settings.obsidianVaultId, list, { recreateMissing })]);
    if (entry.status === 'rejected') addResult(result, 'failed', { id: list.id, reason: entry.reason?.message || 'write failed' });
    else if (entry.value.kind === 'exported') addResult(result, 'exported', entry.value);
    else addResult(result, entry.value.kind, { id: list.id, ...entry.value });
  }
  return result;
}
