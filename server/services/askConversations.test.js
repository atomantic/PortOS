import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';

const { TEMP_ROOT } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  return { TEMP_ROOT: mkdtempSync(join(tmpdir(), 'ask-conversations-')) };
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, data: TEMP_ROOT },
  };
});

const convs = await import('./askConversations.js');

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  // Fresh scratch state per test — rm then recreate the same dir so the
  // vi.mock of PATHS.data still resolves to a real path.
  rmSync(TEMP_ROOT, { recursive: true, force: true });
  mkdirSync(TEMP_ROOT, { recursive: true });
});

describe('askConversations', () => {
  describe('isValidId', () => {
    it('accepts a canonical literal id', () => {
      // Literal so the regex breaks if the format changes silently —
      // generator round-trips alone wouldn't catch a regex relaxation.
      expect(convs.isValidId('ask_lwg2x4abc_abcdef12')).toBe(true);
    });

    it('accepts ids produced by the generator', () => {
      const id = convs.__test.generateId();
      expect(convs.isValidId(id)).toBe(true);
    });

    it('rejects ids with path traversal characters', () => {
      expect(convs.isValidId('ask_x_..')).toBe(false);
      expect(convs.isValidId('../etc/passwd')).toBe(false);
      expect(convs.isValidId('ask_x/y_abc')).toBe(false);
    });

    it('rejects empty / non-string', () => {
      expect(convs.isValidId('')).toBe(false);
      expect(convs.isValidId(null)).toBe(false);
      expect(convs.isValidId(undefined)).toBe(false);
      expect(convs.isValidId(123)).toBe(false);
    });
  });

  describe('createConversation', () => {
    it('creates a conversation with a usable id and persists it', async () => {
      const conv = await convs.createConversation({ mode: 'ask', title: 'Hello world' });
      expect(convs.isValidId(conv.id)).toBe(true);
      expect(conv.mode).toBe('ask');
      expect(conv.title).toBe('Hello world');
      expect(conv.turns).toEqual([]);
      const refetch = await convs.getConversation(conv.id);
      expect(refetch).toEqual(conv);
    });

    it('rejects invalid modes', async () => {
      await expect(convs.createConversation({ mode: 'shout' })).rejects.toThrow(/Invalid mode/);
    });

    it('truncates long titles', async () => {
      const long = 'x'.repeat(500);
      const conv = await convs.createConversation({ title: long });
      expect(conv.title.length).toBeLessThanOrEqual(convs.TITLE_MAX_LENGTH);
      expect(conv.title.endsWith('…')).toBe(true);
    });
  });

  describe('appendTurn', () => {
    it('appends user then assistant turns', async () => {
      const conv = await convs.createConversation({ mode: 'ask' });
      await convs.appendTurn(conv.id, { role: 'user', content: 'What did I decide last week?' });
      const { conversation } = await convs.appendTurn(conv.id, {
        role: 'assistant',
        content: 'You decided to ship slice (a) first.',
        sources: [{ kind: 'memory', id: 'memory:1', title: 'Decision', snippet: 'shipped slice a' }],
      });
      expect(conversation.turns).toHaveLength(2);
      expect(conversation.turns[0].role).toBe('user');
      expect(conversation.turns[1].sources).toHaveLength(1);
    });

    it('uses the first user turn as the conversation title when none was given', async () => {
      const conv = await convs.createConversation({ mode: 'ask' });
      // createConversation defaulted to "(new conversation)" — the first user
      // turn should overwrite it so the listing is meaningful.
      const { conversation } = await convs.appendTurn(conv.id, {
        role: 'user',
        content: 'Should I move my workout to mornings?',
      });
      expect(conversation.title).toMatch(/Should I move my workout/);
    });

    it('rejects unknown roles', async () => {
      const conv = await convs.createConversation({ mode: 'ask' });
      await expect(convs.appendTurn(conv.id, { role: 'system', content: 'x' })).rejects.toThrow(/role/);
    });

    it('rejects unknown conversation ids', async () => {
      await expect(convs.appendTurn('ask_zzzzzzzzz_deadbeef', { role: 'user', content: 'x' })).rejects.toThrow(/not found/);
    });
  });

  describe('listConversations', () => {
    it('returns summaries newest-first', async () => {
      const a = await convs.createConversation({ title: 'oldest' });
      // Force distinct updatedAt timestamps so the sort is deterministic.
      await new Promise((r) => setTimeout(r, 5));
      await convs.appendTurn(a.id, { role: 'user', content: 'oldest q' });
      const b = await convs.createConversation({ title: 'newest' });
      await new Promise((r) => setTimeout(r, 5));
      await convs.appendTurn(b.id, { role: 'user', content: 'newest q' });

      const summaries = await convs.listConversations();
      expect(summaries.map((s) => s.id)).toEqual([b.id, a.id]);
      expect(summaries[0].turnCount).toBe(1);
    });

    it('prunes non-promoted conversations older than 30 days', async () => {
      const stale = await convs.createConversation({ title: 'stale' });
      // Backdate the file by writing a stale updatedAt. We cheat by re-saving
      // the conversation with an old timestamp via the underlying path.
      const { writeFileSync, readFileSync } = await import('fs');
      const path = convs.__test.pathFor(stale.id);
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      data.updatedAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(path, JSON.stringify(data));

      const summaries = await convs.listConversations();
      expect(summaries.find((s) => s.id === stale.id)).toBeUndefined();
    });

    it('keeps promoted conversations regardless of age', async () => {
      const promoted = await convs.createConversation({ title: 'pinned' });
      await convs.setPromoted(promoted.id, true);
      const { writeFileSync, readFileSync } = await import('fs');
      const path = convs.__test.pathFor(promoted.id);
      const data = JSON.parse(readFileSync(path, 'utf-8'));
      data.updatedAt = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      writeFileSync(path, JSON.stringify(data));

      const summaries = await convs.listConversations();
      expect(summaries.find((s) => s.id === promoted.id)).toBeDefined();
    });
  });

  describe('deleteConversation', () => {
    it('removes the file and reports true', async () => {
      const conv = await convs.createConversation({ title: 'to delete' });
      const removed = await convs.deleteConversation(conv.id);
      expect(removed).toBe(true);
      expect(await convs.getConversation(conv.id)).toBeNull();
    });

    it('returns false when nothing was deleted', async () => {
      const fakeId = convs.__test.generateId();
      expect(await convs.deleteConversation(fakeId)).toBe(false);
    });

    it('refuses path-traversal ids', async () => {
      expect(await convs.deleteConversation('../etc/passwd')).toBe(false);
    });
  });
});
