import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createHash } from 'crypto';

vi.mock('./obsidian.js', () => ({
  getVaultById: vi.fn(),
  scanVault: vi.fn(),
  getNote: vi.fn(),
  createNote: vi.fn(),
  updateNote: vi.fn(),
}));

vi.mock('./idealoomLists.js', () => ({
  getSettings: vi.fn(),
  getList: vi.fn(),
  listLists: vi.fn(),
  upsertImportedList: vi.fn(),
  updateSyncMetadata: vi.fn(),
}));

import * as obsidian from './obsidian.js';
import * as lists from './idealoomLists.js';
import {
  importFromObsidian,
  parseIdeaLoomMarkdown,
  renderIdeaLoomMarkdown,
  exportToObsidian,
} from './idealoomObsidian.js';

const VAULT_ID = '0f6c6a6f-8c16-4c7d-9a8b-2e2f6f2cb4d1';
const LIST_ID = 'f1c2d3e4-5678-4abc-9def-0123456789ab';
let vaultRoot;

const list = (overrides = {}) => ({
  id: LIST_ID,
  prompt: 'What should we build next?',
  title: 'Next steps: "small"',
  category: 'product',
  status: 'draft',
  help: 'Keep the ideas practical.',
  ideas: ['First idea', 'Second idea'],
  createdAt: '2026-08-29T10:00:00.000Z',
  updatedAt: '2026-08-29T11:00:00.000Z',
  ...overrides,
});

const note = (overrides = {}) => ({
  path: 'Idea Loom/2026-08-29-next-steps.md',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  if (vaultRoot) rmSync(vaultRoot, { recursive: true, force: true });
  vaultRoot = mkdtempSync(join(tmpdir(), 'idealoom-obsidian-test-'));
  mkdirSync(join(vaultRoot, 'Idea Loom'), { recursive: true });
  lists.getSettings.mockResolvedValue({ enabled: true, obsidianVaultId: VAULT_ID, autoSync: false });
  obsidian.getVaultById.mockResolvedValue({ id: VAULT_ID, name: 'Example Vault', path: vaultRoot });
  obsidian.scanVault.mockResolvedValue({ vault: { path: vaultRoot }, notes: [], skippedUnavailable: 0 });
  lists.listLists.mockResolvedValue([]);
});

describe('IdeaLoom Markdown contract', () => {
  it('round-trips escaped metadata, help text, and ordered ideas', () => {
    const original = list({ title: 'Quotes "and" \\slashes', help: 'A helpful note: preserve it.' });
    const parsed = parseIdeaLoomMarkdown(renderIdeaLoomMarkdown(original));

    expect(parsed).toEqual({
      ok: true,
      list: expect.objectContaining({
        id: original.id,
        title: original.title,
        category: original.category,
        status: original.status,
        prompt: original.prompt,
        help: original.help,
        ideas: original.ideas,
        createdAt: original.createdAt,
        updatedAt: original.updatedAt,
      }),
    });
  });

  it('round-trips a literal Prompt heading without consuming the first idea', () => {
    const original = list({ prompt: 'Prompt', help: '' });
    const parsed = parseIdeaLoomMarkdown(renderIdeaLoomMarkdown(original));

    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      list: expect.objectContaining({ prompt: 'Prompt', ideas: original.ideas }),
    }));
  });

  it('round-trips Markdown-numbered help and prompt text beginning with a hash', () => {
    const original = list({ prompt: '#1 priority for Q4', help: 'Try these:\n1. warm up\n2. diverge' });
    const parsed = parseIdeaLoomMarkdown(renderIdeaLoomMarkdown(original));

    expect(parsed).toEqual(expect.objectContaining({
      ok: true,
      list: expect.objectContaining({ prompt: original.prompt, help: original.help, ideas: original.ideas }),
    }));
  });

  it('accepts harmless Obsidian Properties metadata', () => {
    const rendered = renderIdeaLoomMarkdown(list());
    const withProperties = rendered.replace('title:', 'aliases:\n  - "Example alias"\ntitle:');

    expect(parseIdeaLoomMarkdown(withProperties)).toEqual(expect.objectContaining({ ok: true }));
    expect(parseIdeaLoomMarkdown(withProperties.replace('tags:\n  - "idea-loom"', 'tags: idea-loom')))
      .toEqual(expect.objectContaining({ ok: true }));
  });

  it('accepts YAML flow-sequence tags alongside the block-list and bare-scalar shapes', () => {
    const rendered = renderIdeaLoomMarkdown(list());
    const withFlowTags = rendered.replace('tags:\n  - "idea-loom"', 'tags: [idea-loom, other-note]');
    expect(parseIdeaLoomMarkdown(withFlowTags)).toEqual(expect.objectContaining({ ok: true }));
  });

  it('rejects malformed metadata and non-dense numbered ideas', () => {
    const rendered = renderIdeaLoomMarkdown(list());
    expect(parseIdeaLoomMarkdown(rendered.replace(`id: "${LIST_ID}"`, 'id: "not-a-uuid"')).ok).toBe(false);
    expect(parseIdeaLoomMarkdown(rendered.replace('status: "draft"', 'status: "archived"')).ok).toBe(false);
    expect(parseIdeaLoomMarkdown(rendered.replace('1. First idea\n2. Second idea', '1. First idea\n3. Second idea')).error)
      .toMatch(/dense/);
    expect(parseIdeaLoomMarkdown('---\nid: "' + LIST_ID + '"\n---\n# Prompt').ok).toBe(false);
    expect(parseIdeaLoomMarkdown(rendered.replace('  - "idea-loom"', '  - "other-note"')).error)
      .toMatch(/idea-loom/);
    expect(parseIdeaLoomMarkdown(rendered.replace(`title: "Next steps: \\\"small\\\""`, `title: "${'x'.repeat(201)}"`)).error)
      .toMatch(/limits/);
  });
});

describe('IdeaLoom Obsidian exchange', () => {
  it('does no vault I/O while disabled or unconfigured', async () => {
    lists.getSettings.mockResolvedValueOnce({ enabled: false, obsidianVaultId: null, autoSync: false });
    expect((await importFromObsidian()).counts.skipped).toBe(1);
    expect(obsidian.getVaultById).not.toHaveBeenCalled();
    expect(obsidian.scanVault).not.toHaveBeenCalled();

    lists.getSettings.mockResolvedValueOnce({ enabled: true, obsidianVaultId: null, autoSync: false });
    expect((await exportToObsidian()).counts.skipped).toBe(1);
    expect(obsidian.getVaultById).not.toHaveBeenCalled();
  });

  it('imports valid notes, surfaces malformed and unavailable notes, and is idempotent', async () => {
    const valid = renderIdeaLoomMarkdown(list());
    const validNote = note();
    const malformedNote = note({ path: 'Idea Loom/malformed.md' });
    const unavailableNote = note({ path: 'Idea Loom/cloud.md' });
    obsidian.scanVault.mockResolvedValue({
      vault: { path: vaultRoot },
      notes: [validNote, malformedNote, unavailableNote],
      skippedUnavailable: 0,
    });
    obsidian.getNote.mockImplementation(async (_vaultId, path) => {
      if (path === validNote.path) return { content: valid };
      if (path === malformedNote.path) return { content: 'not IdeaLoom' };
      return { error: 'NOTE_EVICTED' };
    });
    let stored = null;
    lists.getList.mockImplementation(async () => stored);
    lists.upsertImportedList.mockImplementation(async (id, data) => { stored = { id, ...data }; return stored; });

    const first = await importFromObsidian();
    expect(first.counts).toMatchObject({ imported: 1, malformed: 1, unavailable: 1 });
    expect(lists.upsertImportedList).toHaveBeenCalledWith(LIST_ID, expect.objectContaining({
      sync: expect.objectContaining({ notePath: validNote.path, lastKnownContentHash: expect.any(String) }),
    }));

    const second = await importFromObsidian();
    expect(second.counts).toMatchObject({ skipped: 1, malformed: 1, unavailable: 1 });
    expect(lists.upsertImportedList).toHaveBeenCalledOnce();
  });

  it('reports an import conflict instead of overwriting local edits', async () => {
    const base = renderIdeaLoomMarkdown(list());
    const external = renderIdeaLoomMarkdown(list({ ideas: ['External edit'] }));
    const importedPath = note().path;
    obsidian.scanVault.mockResolvedValue({ vault: { path: vaultRoot }, notes: [note()], skippedUnavailable: 0 });
    obsidian.getNote.mockResolvedValue({ content: external });
    lists.getList.mockResolvedValue({
      ...list({ updatedAt: '2026-08-29T12:00:00.000Z' }),
      sync: {
        notePath: importedPath,
        lastKnownContentHash: createHash('sha256').update(base, 'utf8').digest('hex'),
        lastImportedAt: '2026-08-29T11:00:00.000Z',
      },
    });

    const result = await importFromObsidian();

    expect(result.counts).toMatchObject({ conflicted: 1, imported: 0 });
    expect(lists.upsertImportedList).not.toHaveBeenCalled();
  });

  it('skips duplicate UUIDs without importing either note', async () => {
    const valid = renderIdeaLoomMarkdown(list());
    const first = note();
    const second = note({ path: 'Idea Loom/duplicate.md' });
    obsidian.scanVault.mockResolvedValue({ vault: { path: vaultRoot }, notes: [first, second], skippedUnavailable: 0 });
    obsidian.getNote.mockResolvedValue({ content: valid });

    const result = await importFromObsidian();
    expect(result.counts).toMatchObject({ skipped: 2, imported: 0 });
    expect(result.details.skipped.every((entry) => entry.reason === 'duplicate-id')).toBe(true);
    expect(lists.upsertImportedList).not.toHaveBeenCalled();
  });

  it('exports a new list and preserves an imported filename', async () => {
    const local = list();
    lists.listLists.mockResolvedValue([local]);
    obsidian.getNote.mockResolvedValue({ error: 'NOTE_NOT_FOUND' });
    obsidian.createNote.mockResolvedValue({ path: 'created' });

    const created = await exportToObsidian();
    expect(created.counts.exported).toBe(1);
    expect(obsidian.createNote).toHaveBeenCalledWith(VAULT_ID, expect.stringMatching(/^Idea Loom\/2026-08-29-next-steps-small\.md$/), expect.stringContaining('1. First idea'));
    expect(lists.updateSyncMetadata).toHaveBeenCalledWith(LIST_ID, expect.objectContaining({ notePath: expect.stringContaining('Idea Loom/') }));

    const importedPath = 'Idea Loom/2026-01-01-original-name.md';
    const importedList = list({ id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' });
    lists.listLists.mockResolvedValue([local, {
      ...importedList,
      // Edited locally since the last exchange, so this is a real export rather
      // than the no-op an unchanged list would be skipped for.
      ideas: ['First idea', 'Second idea', 'Third idea'],
      updatedAt: '2026-08-29T13:00:00.000Z',
      sync: {
        notePath: importedPath,
        lastKnownContentHash: createHash('sha256').update(renderIdeaLoomMarkdown(importedList), 'utf8').digest('hex'),
        lastImportedAt: importedList.updatedAt,
      },
    }]);
    obsidian.getNote.mockImplementation(async (_id, path) => path === importedPath
      ? { content: renderIdeaLoomMarkdown(list({ id: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' })) }
      : { error: 'NOTE_NOT_FOUND' });
    obsidian.updateNote.mockResolvedValue({ path: importedPath });
    obsidian.createNote.mockResolvedValue({ path: 'created' });

    const exported = await exportToObsidian({ listId: '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d' });
    expect(exported.counts.exported).toBe(1);
    expect(obsidian.updateNote).toHaveBeenCalledWith('0f6c6a6f-8c16-4c7d-9a8b-2e2f6f2cb4d1', importedPath, expect.any(String));
  });

  it('does not overwrite a note changed on both sides', async () => {
    const base = renderIdeaLoomMarkdown(list());
    const external = renderIdeaLoomMarkdown(list({ ideas: ['External edit'] }));
    const importedPath = 'Idea Loom/2026-01-01-original-name.md';
    const local = list({
      updatedAt: '2026-08-29T12:00:00.000Z',
      sync: {
        notePath: importedPath,
        lastKnownContentHash: createHash('sha256').update(base, 'utf8').digest('hex'),
        lastImportedAt: '2026-08-29T11:00:00.000Z',
      },
    });
    lists.listLists.mockResolvedValue([local]);
    obsidian.getNote.mockResolvedValue({ content: external });

    const result = await exportToObsidian();

    expect(result.counts).toMatchObject({ conflicted: 1, exported: 0 });
    expect(obsidian.updateNote).not.toHaveBeenCalled();
  });

  it('reports an externally deleted note as missing instead of recreating it', async () => {
    const notePath = 'Idea Loom/2026-01-01-original-name.md';
    const synced = list({
      sync: {
        notePath,
        lastKnownContentHash: createHash('sha256').update(renderIdeaLoomMarkdown(list()), 'utf8').digest('hex'),
        lastImportedAt: '2026-08-29T11:00:00.000Z',
      },
    });
    lists.listLists.mockResolvedValue([synced]);
    obsidian.getNote.mockResolvedValue({ error: 'NOTE_NOT_FOUND' });

    const automatic = await exportToObsidian();

    expect(automatic.counts).toMatchObject({ missing: 1, exported: 0 });
    expect(automatic.details.missing[0]).toMatchObject({ id: LIST_ID, notePath, reason: 'note-deleted-externally' });
    expect(obsidian.createNote).not.toHaveBeenCalled();
    expect(obsidian.updateNote).not.toHaveBeenCalled();

    obsidian.createNote.mockResolvedValue({ path: notePath });
    const recovered = await exportToObsidian({ recreateMissing: true });

    expect(recovered.counts).toMatchObject({ missing: 0, exported: 1 });
    expect(obsidian.createNote).toHaveBeenCalledWith(VAULT_ID, notePath, expect.stringContaining('1. First idea'));
  });

  it('surfaces a deleted note on import without dropping the local list', async () => {
    const notePath = 'Idea Loom/2026-01-01-original-name.md';
    lists.listLists.mockResolvedValue([list({
      sync: {
        notePath,
        lastKnownContentHash: 'stale-hash',
        lastImportedAt: '2026-08-29T11:00:00.000Z',
      },
    })]);

    const result = await importFromObsidian();

    expect(result.counts).toMatchObject({ missing: 1, imported: 0 });
    expect(result.details.missing[0]).toMatchObject({ id: LIST_ID, path: notePath });
  });

  it('does not rewrite a note that already matches the list (no import/export loop)', async () => {
    const notePath = 'Idea Loom/2026-01-01-original-name.md';
    const content = renderIdeaLoomMarkdown(list());
    lists.listLists.mockResolvedValue([list({
      sync: {
        notePath,
        // The hash the importer stored, so nothing looks externally changed.
        lastKnownContentHash: createHash('sha256').update(content, 'utf8').digest('hex'),
        lastImportedAt: '2026-08-29T12:00:00.000Z',
      },
    })]);
    obsidian.getNote.mockResolvedValue({ content });

    const result = await exportToObsidian();

    expect(result.counts).toMatchObject({ exported: 0, skipped: 1, conflicted: 0 });
    expect(result.details.skipped[0]).toMatchObject({ reason: 'unchanged' });
    expect(obsidian.updateNote).not.toHaveBeenCalled();
    expect(obsidian.createNote).not.toHaveBeenCalled();
  });
});
