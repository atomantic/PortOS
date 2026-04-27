import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

// Redirect PATHS.brain to a temp dir BEFORE importing the service so that
// IMPORT_ROOT (computed at module load) lands inside the temp tree.
let TMP;
let createMemoryEntryMock;

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, brain: TMP }
  };
});

vi.mock('./brainStorage.js', () => ({
  createMemoryEntry: vi.fn(async (data) => ({ id: `mem-${Math.random().toString(36).slice(2, 8)}`, ...data }))
}));

let parseExport;
let importConversations;
let extractMessages;
let formatTranscript;

describe('chatgptImport service', () => {
  beforeEach(async () => {
    TMP = await mkdtemp(join(tmpdir(), 'portos-chatgpt-'));
    // Re-require the module so it picks up the new TMP
    vi.resetModules();
    vi.doMock('../lib/fileUtils.js', async () => {
      const actual = await vi.importActual('../lib/fileUtils.js');
      return { ...actual, PATHS: { ...actual.PATHS, brain: TMP } };
    });
    vi.doMock('./brainStorage.js', () => ({
      createMemoryEntry: vi.fn(async (data) => ({ id: `mem-${Math.random().toString(36).slice(2, 8)}`, ...data }))
    }));
    const mod = await import('./chatgptImport.js');
    parseExport = mod.parseExport;
    importConversations = mod.importConversations;
    extractMessages = mod.extractMessages;
    formatTranscript = mod.formatTranscript;
    const storage = await import('./brainStorage.js');
    createMemoryEntryMock = storage.createMemoryEntry;
  });

  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  const sampleConversation = (overrides = {}) => ({
    id: 'conv-1',
    title: 'Hello world',
    create_time: 1700000000,
    update_time: 1700000100,
    current_node: 'n2',
    mapping: {
      'root': { id: 'root', message: null, parent: null, children: ['n1'] },
      'n1': {
        id: 'n1',
        parent: 'root',
        children: ['n2'],
        message: {
          id: 'm1',
          author: { role: 'user' },
          create_time: 1700000010,
          content: { content_type: 'text', parts: ['What is 2+2?'] }
        }
      },
      'n2': {
        id: 'n2',
        parent: 'n1',
        children: [],
        message: {
          id: 'm2',
          author: { role: 'assistant' },
          create_time: 1700000020,
          content: { content_type: 'text', parts: ['4'] }
        }
      }
    },
    ...overrides
  });

  describe('extractMessages', () => {
    it('walks the mapping tree from current_node back to root, in order', () => {
      const messages = extractMessages(sampleConversation());
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(messages[0].text).toBe('What is 2+2?');
      expect(messages[1].text).toBe('4');
    });

    it('skips system messages and empty messages', () => {
      const conv = sampleConversation();
      conv.mapping.n1.message.author.role = 'system';
      const messages = extractMessages(conv);
      expect(messages.map((m) => m.role)).toEqual(['assistant']);
    });

    it('returns [] for malformed input', () => {
      expect(extractMessages(null)).toEqual([]);
      expect(extractMessages({})).toEqual([]);
      expect(extractMessages({ mapping: {}, current_node: 'missing' })).toEqual([]);
    });

    it('handles parts that are objects (image_asset_pointer)', () => {
      const conv = sampleConversation();
      conv.mapping.n1.message.content.parts = [{ content_type: 'image_asset_pointer', asset_pointer: 'foo' }];
      const messages = extractMessages(conv);
      expect(messages[0].text).toContain('[image]');
    });
  });

  describe('parseExport', () => {
    it('accepts a top-level array of conversations', () => {
      const result = parseExport([sampleConversation()]);
      expect(result.ok).toBe(true);
      expect(result.summary.totalConversations).toBe(1);
      expect(result.summary.totalMessages).toBe(2);
      expect(result.summary.earliest).toBe(new Date(1700000000 * 1000).toISOString());
    });

    it('accepts an object with a conversations array', () => {
      const result = parseExport({ conversations: [sampleConversation()] });
      expect(result.ok).toBe(true);
      expect(result.summary.totalConversations).toBe(1);
    });

    it('rejects non-array, non-object payloads', () => {
      expect(parseExport('not json').ok).toBe(false);
      expect(parseExport({ random: 'thing' }).ok).toBe(false);
      expect(parseExport([]).ok).toBe(false);
    });
  });

  describe('importConversations', () => {
    it('creates a Memory entry per conversation and archives full transcripts', async () => {
      const parsed = parseExport([sampleConversation(), sampleConversation({ id: 'conv-2', title: 'Second' })]);
      const result = await importConversations(parsed, { tags: ['chatgpt-import', 'archive'] });
      expect(result.ok).toBe(true);
      expect(result.imported).toBe(2);
      expect(result.skipped).toBe(0);
      expect(result.archived).toBe(2);
      expect(createMemoryEntryMock).toHaveBeenCalledTimes(2);
      const firstCall = createMemoryEntryMock.mock.calls[0][0];
      expect(firstCall.title).toBe('Hello world');
      expect(firstCall.tags).toEqual(expect.arrayContaining(['chatgpt-import', 'archive']));
      expect(firstCall.source).toBe('chatgpt-import');
      expect(firstCall.content).toContain('What is 2+2?');

      const archives = await readdir(join(TMP, 'imports', 'chatgpt'));
      expect(archives.length).toBe(2);
      const archived = JSON.parse(await readFile(join(TMP, 'imports', 'chatgpt', archives[0]), 'utf8'));
      expect(archived.messages.length).toBe(2);
      expect(archived.transcript).toContain('What is 2+2?');
    });

    it('skips empty conversations when skipEmpty is true (default)', async () => {
      const empty = sampleConversation({ id: 'empty', current_node: 'root', mapping: { root: { id: 'root', parent: null, children: [], message: null } } });
      const parsed = parseExport([empty, sampleConversation()]);
      const result = await importConversations(parsed);
      expect(result.imported).toBe(1);
      expect(result.skipped).toBe(1);
    });

    it('sanitizes user-supplied tags', async () => {
      const parsed = parseExport([sampleConversation()]);
      const result = await importConversations(parsed, { tags: ['Hello World!', '   ', 'a/b'] });
      expect(result.ok).toBe(true);
      const tags = createMemoryEntryMock.mock.calls[0][0].tags;
      expect(tags).toContain('hello-world');
      expect(tags).toContain('a-b');
      expect(tags).not.toContain('   ');
    });

    it('truncates very long transcripts but preserves a pointer', async () => {
      const huge = sampleConversation();
      huge.mapping.n2.message.content.parts = ['x'.repeat(50000)];
      const parsed = parseExport([huge]);
      const result = await importConversations(parsed);
      expect(result.ok).toBe(true);
      const content = createMemoryEntryMock.mock.calls[0][0].content;
      expect(content.length).toBeLessThan(10000);
      expect(content).toContain('truncated');
    });
  });

  describe('formatTranscript', () => {
    it('renders user and assistant messages with role labels', () => {
      const messages = extractMessages(sampleConversation());
      const transcript = formatTranscript(messages);
      expect(transcript).toContain('**You**');
      expect(transcript).toContain('**ChatGPT**');
      expect(transcript).toContain('What is 2+2?');
    });
  });
});
