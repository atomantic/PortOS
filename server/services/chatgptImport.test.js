import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readdir, readFile, mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Each test gets its own temp dir; the actual mocks are installed via
// vi.doMock + vi.resetModules in beforeEach so PATHS.brain points at a
// fresh per-test TMP before chatgptImport.js is (re-)loaded.
let TMP;
let createMemoryEntryMock;

let parseExport;
let importConversations;
let extractMessages;
let formatTranscript;
let readArchivedConversation;
let deleteMemoryAssets;
let extractAssetFileNames;
let ASSETS_DIR;

describe('chatgptImport service', () => {
  beforeEach(async () => {
    TMP = await mkdtemp(join(tmpdir(), 'portos-chatgpt-'));
    // Re-require the module so it picks up the new TMP
    vi.resetModules();
    ASSETS_DIR = join(TMP, 'imports', 'assets');
    vi.doMock('../lib/fileUtils.js', async () => {
      const actual = await vi.importActual('../lib/fileUtils.js');
      return { ...actual, PATHS: { ...actual.PATHS, brain: TMP, brainImportAssets: ASSETS_DIR } };
    });
    vi.doMock('./brainStorage.js', () => ({
      createMemoryEntry: vi.fn(async (data) => ({ id: `mem-${Math.random().toString(36).slice(2, 8)}`, ...data }))
    }));
    const mod = await import('./chatgptImport.js');
    parseExport = mod.parseExport;
    importConversations = mod.importConversations;
    extractMessages = mod.extractMessages;
    formatTranscript = mod.formatTranscript;
    readArchivedConversation = mod.readArchivedConversation;
    deleteMemoryAssets = mod.deleteMemoryAssets;
    extractAssetFileNames = mod.__test.extractAssetFileNames;
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

    it('inlines image/audio assets as markdown when an assetResolver is supplied', () => {
      const conv = sampleConversation();
      conv.mapping.n1.message.content.parts = [
        'See:',
        { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG' },
        { content_type: 'audio_asset_pointer', asset_pointer: 'sediment://file_SND' },
      ];
      const assetResolver = (ptr) => {
        const id = String(ptr).replace(/^file-service:\/\/|^sediment:\/\//, '');
        if (id === 'file-IMG') return { url: '/data/brain-imports/file-IMG.png', name: 'pic.png', mime: 'image/png' };
        if (id === 'file_SND') return { url: '/data/brain-imports/file_SND.wav', name: 'clip.wav', mime: 'audio/wav' };
        return null;
      };
      const messages = extractMessages(conv, { assetResolver });
      expect(messages[0].text).toContain('![pic.png](/data/brain-imports/file-IMG.png)');
      expect(messages[0].text).toContain('[🔊 clip.wav](/data/brain-imports/file_SND.wav)');
      expect(messages[0].text).not.toContain('[image]');
    });

    it('renders message attachments (PDFs/docs) as a link footer, deduped against inlined images', () => {
      const conv = sampleConversation();
      conv.mapping.n1.message.content.parts = [
        { content_type: 'image_asset_pointer', asset_pointer: 'file-service://file-IMG' },
      ];
      conv.mapping.n1.message.metadata = {
        attachments: [
          { id: 'file-IMG', name: 'pic.png', mime_type: 'image/png' }, // already inlined → skipped
          { id: 'file-DOC', name: 'report.pdf', mime_type: 'application/pdf' },
        ],
      };
      const assetResolver = (ptr) => {
        const id = String(ptr).replace(/^file-service:\/\//, '');
        if (id === 'file-IMG') return { url: '/data/brain-imports/file-IMG.png', name: 'pic.png', mime: 'image/png' };
        if (id === 'file-DOC') return { url: '/data/brain-imports/file-DOC.pdf', name: 'report.pdf', mime: 'application/pdf' };
        return null;
      };
      const messages = extractMessages(conv, { assetResolver });
      // image inlined once, pdf in the footer, no duplicate image link
      expect(messages[0].text).toContain('![pic.png](/data/brain-imports/file-IMG.png)');
      expect(messages[0].text).toContain('[📎 report.pdf](/data/brain-imports/file-DOC.pdf)');
      expect((messages[0].text.match(/file-IMG\.png/g) || []).length).toBe(1);
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

    it('flattens a multi-file export (conversationFiles: array of shards)', () => {
      const result = parseExport({
        conversationFiles: [
          [sampleConversation({ id: 'a' })],
          { conversations: [sampleConversation({ id: 'b' }), sampleConversation({ id: 'c' })] },
        ],
      });
      expect(result.ok).toBe(true);
      expect(result.summary.totalConversations).toBe(3);
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
      // Both source clocks persist so the memory list can order imports by the
      // original conversation recency (not the shared bulk-import timestamp).
      expect(firstCall.sourceCreatedAt).toBe(new Date(1700000000 * 1000).toISOString());
      expect(firstCall.sourceUpdatedAt).toBe(new Date(1700000100 * 1000).toISOString());

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

  describe('readArchivedConversation', () => {
    it('reads a legitimately-named archive file', async () => {
      // importConversations writes the archive as `${safeFilename(id)}.json`.
      await importConversations(parseExport([sampleConversation()]));
      const archived = await readArchivedConversation('conv-1.json');
      expect(archived).not.toBeNull();
      expect(archived.transcript).toContain('What is 2+2?');
    });

    it('rejects path-traversal / non-flat names without reading outside the archive dir', async () => {
      // The guard regex is the only thing standing between req.params.name and
      // an arbitrary-file read — a future weakening (adding `.` or `/` to the
      // class) must fail this test, not silently traverse.
      for (const evil of ['../../etc/passwd', 'a/b.json', '..%2fx.json', '/etc/passwd', 'x.json.bak', 'x.txt', '']) {
        // eslint-disable-next-line no-await-in-loop
        expect(await readArchivedConversation(evil)).toBeNull();
      }
    });

    it('returns null for a well-formed name with no matching file', async () => {
      expect(await readArchivedConversation('does-not-exist.json')).toBeNull();
    });
  });

  describe('extractAssetFileNames', () => {
    it('pulls flat asset filenames out of markdown content', () => {
      const content = [
        '![cat](/data/brain-imports/file-abc.png)',
        '[🔊 voice](/data/brain-imports/file-def.mp3)',
        'Some text with a [📎 doc](/data/brain-imports/file-ghi.pdf).',
      ].join('\n');
      const names = extractAssetFileNames(content);
      expect([...names].sort()).toEqual(['file-abc.png', 'file-def.mp3', 'file-ghi.pdf']);
    });

    it('ignores unrelated urls and rejects path-traversal segments', () => {
      const content = [
        '![ext](https://example.com/x.png)',
        '![evil](/data/brain-imports/../../../etc/passwd)',
        '![ok](/data/brain-imports/file-ok.png)',
      ].join('\n');
      expect([...extractAssetFileNames(content)]).toEqual(['file-ok.png']);
    });

    it('rejects non-asset-charset tails (query strings, url-encoded dots) the basename guard let through', () => {
      // Both names below contain no bare `/`, `\\`, or literal `..`, so they
      // passed the looser prior `!includes()` guard — but neither can name a
      // real on-disk asset. The flat-charset anchor is what rejects them, so
      // this pins the hardening (it would fail under the prior guard).
      const content = [
        '![q](/data/brain-imports/file-q.png?sig=abc)',  // query-string tail
        '![pct](/data/brain-imports/file%2e%2e.png)',    // url-encoded dots (not literal `..`)
        '![ok](/data/brain-imports/file-ok2.png)',
      ].join('\n');
      expect([...extractAssetFileNames(content)]).toEqual(['file-ok2.png']);
    });

    it('rejects a literal `..` name the charset alone would admit (join → parent dir)', () => {
      // The flat charset includes `.`, so `..` / `a..b` match it — but `..`
      // resolves to the parent dir under join(). The explicit `..` reject keeps
      // the guard a true superset of the prior path-traversal check.
      const content = [
        '![dd](/data/brain-imports/..)',
        '![seg](/data/brain-imports/a..b.png)',
        '![ok](/data/brain-imports/file-ok3.png)',
      ].join('\n');
      expect([...extractAssetFileNames(content)]).toEqual(['file-ok3.png']);
    });

    it('returns an empty set for non-string / asset-free content', () => {
      expect(extractAssetFileNames(null).size).toBe(0);
      expect(extractAssetFileNames('plain memory text').size).toBe(0);
    });
  });

  describe('deleteMemoryAssets', () => {
    const writeAsset = async (name) => {
      await mkdir(ASSETS_DIR, { recursive: true });
      await writeFile(join(ASSETS_DIR, name), 'x');
    };

    it('removes the archived transcript and orphaned assets of a deleted import', async () => {
      await importConversations(parseExport([sampleConversation()])); // writes conv-1.json archive
      await writeAsset('file-a.png');
      await writeAsset('file-b.mp3');
      expect(existsSync(join(TMP, 'imports', 'chatgpt', 'conv-1.json'))).toBe(true);

      await deleteMemoryAssets({
        id: 'mem-1',
        source: 'chatgpt-import',
        sourceRef: 'conv-1.json',
        content: '![a](/data/brain-imports/file-a.png)\n[🔊](/data/brain-imports/file-b.mp3)',
      }, []);

      expect(existsSync(join(TMP, 'imports', 'chatgpt', 'conv-1.json'))).toBe(false);
      expect(existsSync(join(ASSETS_DIR, 'file-a.png'))).toBe(false);
      expect(existsSync(join(ASSETS_DIR, 'file-b.mp3'))).toBe(false);
    });

    it('keeps an asset that a surviving import memory still references', async () => {
      await writeAsset('file-shared.png');
      await writeAsset('file-solo.png');

      await deleteMemoryAssets({
        id: 'mem-1',
        source: 'chatgpt-import',
        sourceRef: 'gone.json',
        content: '![s](/data/brain-imports/file-shared.png)\n![x](/data/brain-imports/file-solo.png)',
      }, [{ id: 'mem-2', sourceRef: 'other.json', content: '![still](/data/brain-imports/file-shared.png)' }]);

      // Shared asset survives (another memory uses it); solo asset is removed.
      expect(existsSync(join(ASSETS_DIR, 'file-shared.png'))).toBe(true);
      expect(existsSync(join(ASSETS_DIR, 'file-solo.png'))).toBe(false);
    });

    it('keeps an asset a survivor references only in its full archive transcript (beyond truncated content)', async () => {
      await writeAsset('file-tail.png');
      // Write a survivor's archive whose TRANSCRIPT references the asset, while
      // the survivor's stored `content` (passed below) does NOT — simulating a
      // link that fell past the memory's truncation point.
      await importConversations(parseExport([sampleConversation({
        id: 'survivor-conv',
        mapping: {
          n1: { id: 'n1', parent: null, message: { id: 'm-a', author: { role: 'user' }, content: { parts: ['![tail](/data/brain-imports/file-tail.png)'] }, create_time: 1700000000 } },
        },
        current_node: 'n1',
      })]));

      await deleteMemoryAssets({
        id: 'mem-del',
        source: 'chatgpt-import',
        sourceRef: 'gone.json',
        content: '![t](/data/brain-imports/file-tail.png)',
      }, [{ id: 'mem-survivor', source: 'chatgpt-import', sourceRef: 'survivor-conv.json', content: 'no asset link here' }]);

      // The survivor's archive still links the asset, so it must NOT be unlinked.
      expect(existsSync(join(ASSETS_DIR, 'file-tail.png'))).toBe(true);
    });

    it('keeps the archived transcript when a surviving memory shares its sourceRef (same export imported twice)', async () => {
      await importConversations(parseExport([sampleConversation()])); // writes conv-1.json archive
      expect(existsSync(join(TMP, 'imports', 'chatgpt', 'conv-1.json'))).toBe(true);

      await deleteMemoryAssets({
        id: 'mem-1',
        source: 'chatgpt-import',
        sourceRef: 'conv-1.json',
        content: '',
      }, [{ id: 'mem-2', source: 'chatgpt-import', sourceRef: 'conv-1.json', content: '' }]);

      // A duplicate import points at the same archive — it must survive so the
      // surviving memory's "View full conversation" still resolves.
      expect(existsSync(join(TMP, 'imports', 'chatgpt', 'conv-1.json'))).toBe(true);
    });

    it('is a no-op for non-import memories', async () => {
      await writeAsset('file-keep.png');
      await deleteMemoryAssets({
        id: 'mem-1',
        source: undefined,
        content: '![x](/data/brain-imports/file-keep.png)',
      }, []);
      expect(existsSync(join(ASSETS_DIR, 'file-keep.png'))).toBe(true);
    });

    it('tolerates already-missing files without throwing', async () => {
      await expect(deleteMemoryAssets({
        id: 'mem-1',
        source: 'chatgpt-import',
        sourceRef: 'never-written.json',
        content: '![x](/data/brain-imports/never-written.png)',
      }, [])).resolves.toBeUndefined();
    });
  });
});
