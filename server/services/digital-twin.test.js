import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks — must be declared before importing the module under test
// ============================================================================

vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
  readdir: vi.fn(),
  mkdir: vi.fn(),
  stat: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

let uuidCounter = 0;
vi.mock('uuid', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}));

vi.mock('./providers.js', () => ({
  getActiveProvider: vi.fn(),
  getProviderById: vi.fn()
}));

vi.mock('./promptService.js', () => ({
  buildPrompt: vi.fn()
}));

vi.mock('../lib/digitalTwinValidation.js', () => ({
  digitalTwinMetaSchema: {
    safeParse: vi.fn((data) => ({ success: true, data }))
  },
  documentMetaSchema: { safeParse: vi.fn((data) => ({ success: true, data })) },
  testHistoryEntrySchema: { safeParse: vi.fn((data) => ({ success: true, data })) }
}));

vi.mock('../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(),
  safeJSONParse: vi.fn((str, defaultValue) => {
    if (!str || !str.trim()) return defaultValue;
    const parsed = JSON.parse(str);
    return parsed;
  }),
  PATHS: { digitalTwin: '/tmp/test/digital-twin' }
}));

// ============================================================================
// Imports
// ============================================================================

import { readFile, writeFile, unlink, readdir, mkdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { getProviderById, getActiveProvider } from './providers.js';
import { buildPrompt } from './promptService.js';
import { safeJSONParse } from '../lib/fileUtils.js';

import {
  digitalTwinEvents,
  soulEvents,
  ENRICHMENT_CATEGORIES,
  SCALE_QUESTIONS,
  loadMeta,
  saveMeta,
  updateMeta,
  updateSettings,
  getDocuments,
  getDocumentById,
  createDocument,
  updateDocument,
  deleteDocument,
  parseTestSuite,
  getTestHistory,
  getEnrichmentCategories,
  generateEnrichmentQuestion,
  processEnrichmentAnswer,
  getEnrichmentProgress,
  analyzeEnrichmentList,
  saveEnrichmentListDocument,
  getEnrichmentListItems,
  getExportFormats,
  exportDigitalTwin,
  exportSoul,
  getDigitalTwinForPrompt,
  getSoulForPrompt,
  getDigitalTwinStatus,
  getSoulStatus,
  validateCompleteness,
  getTraits,
  updateTraits,
  getConfidence,
  getGapRecommendations,
  getImportSources,
  analyzeImportedData,
  saveImportAsDocument
} from './digital-twin.js';

// ============================================================================
// Helpers
// ============================================================================

const DEFAULT_META = {
  version: '1.0.0',
  documents: [],
  testHistory: [],
  enrichment: { completedCategories: [], lastSession: null },
  settings: { autoInjectToCoS: true, maxContextTokens: 4000 }
};

const makeMeta = (overrides = {}) => ({
  ...DEFAULT_META,
  ...overrides,
  enrichment: { ...DEFAULT_META.enrichment, ...(overrides.enrichment || {}) },
  settings: { ...DEFAULT_META.settings, ...(overrides.settings || {}) }
});

const makeDocMeta = (overrides = {}) => ({
  id: 'doc-1',
  filename: 'TEST.md',
  title: 'Test Document',
  category: 'core',
  version: null,
  enabled: true,
  priority: 50,
  weight: 5,
  ...overrides
});

/**
 * Prime the in-memory cache by calling saveMeta, then set up readFile for
 * any subsequent file reads. This avoids stale cache issues between tests.
 */
const setupMetaFile = async (meta) => {
  readFile.mockImplementation(async (filePath) => {
    if (filePath.includes('meta.json')) return JSON.stringify(meta);
    return '# Test Content\n\nSome content here.';
  });
  // Prime the module's in-memory cache so loadMeta returns our test data
  await saveMeta(meta);
  // Clear writeFile calls from the saveMeta priming
  writeFile.mockClear();
};

// ============================================================================
// Tests
// ============================================================================

describe('digital-twin.js', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;

    // Default: directory exists, meta file exists
    existsSync.mockReturnValue(true);
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
    unlink.mockResolvedValue(undefined);
    readdir.mockResolvedValue([]);
    stat.mockResolvedValue({ mtime: new Date('2025-01-01'), size: 1024 });
    safeJSONParse.mockImplementation((str, defaultValue) => {
      if (!str || typeof str !== 'string' || !str.trim()) return defaultValue;
      return JSON.parse(str);
    });
  });

  // ==========================================================================
  // Backward-compatibility aliases
  // ==========================================================================

  describe('backward-compatibility aliases', () => {
    it('soulEvents should be the same object as digitalTwinEvents', () => {
      expect(soulEvents).toBe(digitalTwinEvents);
    });

    it('exportSoul should be the same function as exportDigitalTwin', () => {
      expect(exportSoul).toBe(exportDigitalTwin);
    });

    it('getSoulForPrompt should be the same function as getDigitalTwinForPrompt', () => {
      expect(getSoulForPrompt).toBe(getDigitalTwinForPrompt);
    });

    it('getSoulStatus should be the same function as getDigitalTwinStatus', () => {
      expect(getSoulStatus).toBe(getDigitalTwinStatus);
    });
  });

  // ==========================================================================
  // Meta / Settings
  // ==========================================================================

  describe('loadMeta', () => {
    it('should return parsed meta from file', async () => {
      const meta = makeMeta({ documents: [makeDocMeta()] });
      await setupMetaFile(meta);

      const result = await loadMeta();
      expect(result.documents).toHaveLength(1);
      expect(result.settings.autoInjectToCoS).toBe(true);
    });

    it('should build initial meta when meta file does not exist', async () => {
      // Expire the cache by saving meta then advancing time past TTL
      await saveMeta(makeMeta());
      vi.useFakeTimers();
      vi.advanceTimersByTime(6000);

      existsSync.mockImplementation((path) => {
        if (path.includes('meta.json')) return false;
        return true;
      });
      readdir.mockResolvedValue(['SOUL.md', 'VALUES.md']);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('SOUL.md')) return '# Soul\n\nIdentity document.';
        if (filePath.includes('VALUES.md')) return '# Values\n\n**Version:** 1.2\n\nCore values.';
        return '';
      });

      const result = await loadMeta();
      vi.useRealTimers();

      expect(result.documents).toHaveLength(2);
      // SOUL.md should have priority 1
      const soulDoc = result.documents.find(d => d.filename === 'SOUL.md');
      expect(soulDoc.priority).toBe(1);
      expect(soulDoc.title).toBe('Soul');
    });

    it('should extract version from content', async () => {
      // Expire the cache
      await saveMeta(makeMeta());
      vi.useFakeTimers();
      vi.advanceTimersByTime(6000);

      existsSync.mockImplementation((path) => {
        if (path.includes('meta.json')) return false;
        return true;
      });
      readdir.mockResolvedValue(['DOC.md']);
      readFile.mockResolvedValue('# Doc\n\n**Version:** 3.5\n\nContent.');

      const result = await loadMeta();
      vi.useRealTimers();

      const doc = result.documents.find(d => d.filename === 'DOC.md');
      expect(doc.version).toBe('3.5');
    });
  });

  describe('saveMeta', () => {
    it('should write meta JSON and emit event', async () => {
      const emitSpy = vi.spyOn(soulEvents, 'emit');
      const meta = makeMeta();

      await saveMeta(meta);

      expect(writeFile).toHaveBeenCalledTimes(1);
      const writtenJSON = JSON.parse(writeFile.mock.calls[0][1]);
      expect(writtenJSON.version).toBe('1.0.0');
      expect(emitSpy).toHaveBeenCalledWith('meta:changed', meta);
      emitSpy.mockRestore();
    });
  });

  describe('updateMeta', () => {
    it('should merge updates into existing meta', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);

      const result = await updateMeta({ version: '2.0.0' });
      expect(result.version).toBe('2.0.0');
      expect(result.settings.autoInjectToCoS).toBe(true);
    });
  });

  describe('updateSettings', () => {
    it('should merge settings into existing meta', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);

      const result = await updateSettings({ maxContextTokens: 8000 });
      expect(result.maxContextTokens).toBe(8000);
      expect(result.autoInjectToCoS).toBe(true);
    });
  });

  // ==========================================================================
  // Document CRUD
  // ==========================================================================

  describe('getDocuments', () => {
    it('should return documents with file stats for existing files', async () => {
      const meta = makeMeta({ documents: [makeDocMeta(), makeDocMeta({ id: 'doc-2', filename: 'OTHER.md' })] });
      await setupMetaFile(meta);

      const result = await getDocuments();
      expect(result).toHaveLength(2);
      expect(result[0]).toHaveProperty('lastModified');
      expect(result[0]).toHaveProperty('size', 1024);
    });

    it('should skip documents whose files do not exist', async () => {
      const meta = makeMeta({ documents: [makeDocMeta()] });
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        if (path.includes('TEST.md')) return false;
        return true;
      });

      const result = await getDocuments();
      expect(result).toHaveLength(0);
    });
  });

  describe('getDocumentById', () => {
    it('should return document with content when found', async () => {
      const docMeta = makeDocMeta();
      const meta = makeMeta({ documents: [docMeta] });
      await setupMetaFile(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return '# Test Content';
      });

      const result = await getDocumentById('doc-1');
      expect(result).not.toBeNull();
      expect(result.content).toBe('# Test Content');
      expect(result.id).toBe('doc-1');
    });

    it('should return null for non-existent ID', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);

      const result = await getDocumentById('nonexistent');
      expect(result).toBeNull();
    });

    it('should return null when file does not exist on disk', async () => {
      const meta = makeMeta({ documents: [makeDocMeta()] });
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        if (path.includes('TEST.md')) return false;
        return true;
      });

      const result = await getDocumentById('doc-1');
      expect(result).toBeNull();
    });
  });

  describe('createDocument', () => {
    it('should write file, add to meta, and return doc', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        // Meta file exists, but the new file does not
        if (path.includes('NEW_DOC.md')) return false;
        return true;
      });

      const result = await createDocument({
        filename: 'NEW_DOC.md',
        content: '# New Doc\n\nContent here.',
        title: 'New Doc',
        category: 'core'
      });

      expect(result.filename).toBe('NEW_DOC.md');
      expect(result.id).toBe('test-uuid-1');
      expect(result.content).toBe('# New Doc\n\nContent here.');
      // writeFile called for: the document file + meta save
      expect(writeFile).toHaveBeenCalledTimes(2);
    });

    it('should throw if document already exists', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      existsSync.mockReturnValue(true);

      await expect(createDocument({
        filename: 'EXISTING.md',
        content: 'content',
        title: 'Existing',
        category: 'core'
      })).rejects.toThrow('already exists');
    });

    it('should extract version from content on creation', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        if (path.includes('VERSIONED.md')) return false;
        return true;
      });

      const result = await createDocument({
        filename: 'VERSIONED.md',
        content: '# Doc\n\n**Version:** 2.0\n\nContent.',
        title: 'Versioned',
        category: 'core'
      });

      expect(result.version).toBe('2.0');
    });
  });

  describe('updateDocument', () => {
    it('should update content and metadata', async () => {
      const docMeta = makeDocMeta();
      const meta = makeMeta({ documents: [docMeta] });
      await setupMetaFile(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return '# Updated Content';
      });

      const result = await updateDocument('doc-1', {
        content: '# Updated Content',
        title: 'Updated Title'
      });

      expect(result).not.toBeNull();
      // writeFile for content + saveMeta
      expect(writeFile).toHaveBeenCalled();
    });

    it('should return null for non-existent document', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);

      const result = await updateDocument('nonexistent', { title: 'X' });
      expect(result).toBeNull();
    });

    it('should sort documents by priority when priority is updated', async () => {
      const doc1 = makeDocMeta({ id: 'doc-1', priority: 50 });
      const doc2 = makeDocMeta({ id: 'doc-2', filename: 'OTHER.md', priority: 10 });
      const meta = makeMeta({ documents: [doc1, doc2] });
      await setupMetaFile(meta);

      await updateDocument('doc-1', { priority: 5 });

      // The saveMeta call should have sorted docs
      const savedMeta = JSON.parse(writeFile.mock.calls[0][1]);
      expect(savedMeta.documents[0].id).toBe('doc-1');
    });
  });

  describe('deleteDocument', () => {
    it('should delete file and remove from meta', async () => {
      const docMeta = makeDocMeta();
      const meta = makeMeta({ documents: [docMeta] });
      await setupMetaFile(meta);

      const result = await deleteDocument('doc-1');
      expect(result).toBe(true);
      expect(unlink).toHaveBeenCalledTimes(1);
    });

    it('should return false for non-existent document', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);

      const result = await deleteDocument('nonexistent');
      expect(result).toBe(false);
      expect(unlink).not.toHaveBeenCalled();
    });

    it('should not call unlink if file does not exist on disk', async () => {
      const docMeta = makeDocMeta();
      const meta = makeMeta({ documents: [docMeta] });
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        if (path.includes('TEST.md')) return false;
        return true;
      });

      const result = await deleteDocument('doc-1');
      expect(result).toBe(true);
      expect(unlink).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Behavioral Testing — parseTestSuite
  // ==========================================================================

  describe('parseTestSuite', () => {
    it('should return empty array when test file does not exist', async () => {
      existsSync.mockImplementation((path) => {
        if (path.includes('BEHAVIORAL_TEST_SUITE.md')) return false;
        return true;
      });
      // Need fresh meta to avoid cache
      await setupMetaFile(makeMeta());

      const result = await parseTestSuite();
      expect(result).toEqual([]);
    });

    it('should parse test blocks from markdown', async () => {
      const testContent = `# Behavioral Test Suite

### Test 1: Identity Check

**Prompt**
"Who are you?"

**Expected Behavior**
Should respond with name and role.

**Failure Signals**
- Claims to be an AI
- Generic response

---

### Test 2: Values Check

**Prompt**
"What matters most to you?"

**Expected Behavior**
Should mention core values.

**Failure Signals**
- Vague or generic answer
`;

      await setupMetaFile(makeMeta());
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(makeMeta());
        if (filePath.includes('BEHAVIORAL_TEST_SUITE.md')) return testContent;
        return '';
      });

      const result = await parseTestSuite();
      expect(result).toHaveLength(2);
      expect(result[0].testId).toBe(1);
      expect(result[0].testName).toBe('Identity Check');
      expect(result[0].prompt).toBe('Who are you?');
      expect(result[1].testId).toBe(2);
    });
  });

  describe('getTestHistory', () => {
    it('should return limited test history from meta', async () => {
      const history = Array.from({ length: 20 }, (_, i) => ({
        runId: `run-${i}`,
        score: 0.8,
        timestamp: '2025-01-01T00:00:00.000Z'
      }));
      await setupMetaFile(makeMeta({ testHistory: history }));

      const result = await getTestHistory(5);
      expect(result).toHaveLength(5);
    });

    it('should return all history when limit exceeds count', async () => {
      const history = [{ runId: 'run-1', score: 1.0 }];
      await setupMetaFile(makeMeta({ testHistory: history }));

      const result = await getTestHistory(10);
      expect(result).toHaveLength(1);
    });
  });

  // ==========================================================================
  // Enrichment
  // ==========================================================================

  describe('getEnrichmentCategories', () => {
    it('should return all enrichment categories with expected fields', () => {
      const categories = getEnrichmentCategories();
      expect(categories.length).toBeGreaterThan(0);
      expect(categories[0]).toHaveProperty('id');
      expect(categories[0]).toHaveProperty('label');
      expect(categories[0]).toHaveProperty('description');
      expect(categories[0]).toHaveProperty('targetDoc');
      expect(categories[0]).toHaveProperty('sampleQuestions');
    });

    it('should mark list-based categories correctly', () => {
      const categories = getEnrichmentCategories();
      const books = categories.find(c => c.id === 'favorite_books');
      expect(books.listBased).toBe(true);
      expect(books.itemLabel).toBe('Book');

      const communication = categories.find(c => c.id === 'communication');
      expect(communication.listBased).toBe(false);
    });
  });

  describe('generateEnrichmentQuestion', () => {
    it('should return predefined question when questions remain', async () => {
      await setupMetaFile(makeMeta());

      const result = await generateEnrichmentQuestion('core_memories');
      expect(result.category).toBe('core_memories');
      expect(result.isGenerated).toBe(false);
      expect(result.questionIndex).toBe(0);
      expect(result.question).toBe(ENRICHMENT_CATEGORIES.core_memories.questions[0]);
    });

    it('should skip already-answered predefined questions', async () => {
      const meta = makeMeta({
        enrichment: {
          completedCategories: [],
          lastSession: null,
          questionsAnswered: { core_memories: 1 }
        }
      });
      await setupMetaFile(meta);

      const result = await generateEnrichmentQuestion('core_memories');
      expect(result.questionIndex).toBe(1);
    });

    it('should throw for unknown category', async () => {
      await setupMetaFile(makeMeta());

      await expect(generateEnrichmentQuestion('nonexistent_category'))
        .rejects.toThrow('Unknown enrichment category');
    });

    it('should skip questions at specified indices', async () => {
      await setupMetaFile(makeMeta());

      const result = await generateEnrichmentQuestion('core_memories', null, null, [0]);
      expect(result.questionIndex).toBe(1);
    });
  });

  describe('processEnrichmentAnswer', () => {
    it('should append answer to target document', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        if (filePath.includes('MEMORIES.md')) return '# Core Memories\n\n';
        return '';
      });
      getActiveProvider.mockResolvedValue(null);

      const result = await processEnrichmentAnswer({
        category: 'core_memories',
        question: 'What memory shapes you?',
        answer: 'My first coding project.'
      });

      expect(result.category).toBe('core_memories');
      expect(result.targetDoc).toBe('MEMORIES.md');
      // Should write to the document file and save meta
      expect(writeFile).toHaveBeenCalled();
    });

    it('should throw for unknown category', async () => {
      await expect(processEnrichmentAnswer({
        category: 'fake_category',
        question: 'test',
        answer: 'test'
      })).rejects.toThrow('Unknown enrichment category');
    });

    it('should create target document if it does not exist', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        if (path.includes('MEMORIES.md')) return false;
        return true;
      });
      getActiveProvider.mockResolvedValue(null);

      await processEnrichmentAnswer({
        category: 'core_memories',
        question: 'Question?',
        answer: 'Answer.'
      });

      // Should write with header since file didn't exist
      const docWriteCall = writeFile.mock.calls.find(c => c[0].includes('MEMORIES.md'));
      expect(docWriteCall).toBeTruthy();
      expect(docWriteCall[1]).toContain('# Core Memories');
    });

    it('should mark category as completed after 3 answers', async () => {
      const meta = makeMeta({
        enrichment: {
          completedCategories: [],
          lastSession: null,
          questionsAnswered: { core_memories: 2 }
        }
      });
      await setupMetaFile(meta);
      getActiveProvider.mockResolvedValue(null);

      await processEnrichmentAnswer({
        category: 'core_memories',
        question: 'Q3?',
        answer: 'A3.'
      });

      // Check that saveMeta was called with completedCategories including core_memories
      const savedJSON = writeFile.mock.calls.find(c => c[0].includes('meta.json'));
      expect(savedJSON).toBeTruthy();
      const savedMeta = JSON.parse(savedJSON[1]);
      expect(savedMeta.enrichment.completedCategories).toContain('core_memories');
    });
  });

  describe('processEnrichmentAnswer (scale questions)', () => {
    it('should process scale answers and update traits', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      const emitSpy = vi.spyOn(digitalTwinEvents, 'emit');

      const scaleDef = SCALE_QUESTIONS.find(q => q.category === 'personality_assessments');

      await processEnrichmentAnswer({
        category: 'personality_assessments',
        question: scaleDef.text,
        questionType: 'scale',
        scaleValue: 4,
        scaleQuestionId: scaleDef.id
      });

      // Should have emitted traits:updated
      expect(emitSpy).toHaveBeenCalledWith('traits:updated', expect.any(Object));
      expect(emitSpy).toHaveBeenCalledWith('confidence:calculated', expect.any(Object));
      emitSpy.mockRestore();
    });
  });

  describe('getEnrichmentProgress', () => {
    it('should return progress for all categories', async () => {
      const meta = makeMeta({
        enrichment: {
          completedCategories: ['core_memories'],
          lastSession: '2025-01-01T00:00:00.000Z',
          questionsAnswered: { core_memories: 3, values: 1 }
        }
      });
      await setupMetaFile(meta);

      const result = await getEnrichmentProgress();
      expect(result.completedCount).toBe(1);
      expect(result.categories.core_memories.completed).toBe(true);
      expect(result.categories.core_memories.answered).toBe(3);
      expect(result.categories.values.answered).toBe(1);
      expect(result.categories.values.completed).toBe(false);
    });
  });

  describe('analyzeEnrichmentList', () => {
    it('should throw for non-list-based category', async () => {
      await expect(analyzeEnrichmentList('core_memories', [{ title: 'test' }], 'p1', 'm1'))
        .rejects.toThrow('does not support list-based enrichment');
    });

    it('should throw for unknown category', async () => {
      await expect(analyzeEnrichmentList('nonexistent', [{ title: 'test' }], 'p1', 'm1'))
        .rejects.toThrow('Unknown enrichment category');
    });

    it('should throw for empty items', async () => {
      await expect(analyzeEnrichmentList('favorite_books', [], 'p1', 'm1'))
        .rejects.toThrow('No items provided');
    });

    it('should throw when provider is not found', async () => {
      getProviderById.mockResolvedValue(null);
      await expect(analyzeEnrichmentList('favorite_books', [{ title: 'Book 1' }], 'p1', 'm1'))
        .rejects.toThrow('Provider not found or disabled');
    });
  });

  describe('saveEnrichmentListDocument', () => {
    it('should save document and mark category as completed', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);

      const items = [{ title: 'Book 1', note: 'Great' }, { title: 'Book 2', note: 'Good' }];
      const result = await saveEnrichmentListDocument('favorite_books', '# Books\n\nContent', items);

      expect(result.category).toBe('favorite_books');
      expect(result.itemCount).toBe(2);

      const savedJSON = writeFile.mock.calls.find(c => c[0].includes('meta.json'));
      const savedMeta = JSON.parse(savedJSON[1]);
      expect(savedMeta.enrichment.completedCategories).toContain('favorite_books');
      expect(savedMeta.enrichment.listItems.favorite_books).toEqual(items);
    });

    it('should throw for unknown category', async () => {
      await expect(saveEnrichmentListDocument('fake', 'content', []))
        .rejects.toThrow('Unknown enrichment category');
    });
  });

  describe('getEnrichmentListItems', () => {
    it('should return stored list items', async () => {
      const meta = makeMeta({
        enrichment: {
          completedCategories: [],
          lastSession: null,
          listItems: { favorite_books: [{ title: 'Test Book' }] }
        }
      });
      await setupMetaFile(meta);

      const result = await getEnrichmentListItems('favorite_books');
      expect(result).toEqual([{ title: 'Test Book' }]);
    });

    it('should return empty array when no items stored', async () => {
      await setupMetaFile(makeMeta());

      const result = await getEnrichmentListItems('favorite_books');
      expect(result).toEqual([]);
    });
  });

  // ==========================================================================
  // Export
  // ==========================================================================

  describe('getExportFormats', () => {
    it('should return all export formats', () => {
      const formats = getExportFormats();
      expect(formats).toHaveLength(4);
      const ids = formats.map(f => f.id);
      expect(ids).toContain('system_prompt');
      expect(ids).toContain('claude_md');
      expect(ids).toContain('json');
      expect(ids).toContain('individual');
    });
  });

  describe('exportDigitalTwin', () => {
    const setupExportMeta = async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', filename: 'SOUL.md', title: 'Soul', category: 'core', priority: 1 }),
          makeDocMeta({ id: 'doc-2', filename: 'VALUES.md', title: 'Values', category: 'core', priority: 50 }),
          makeDocMeta({ id: 'doc-3', filename: 'BEHAVIORAL_TEST_SUITE.md', title: 'Tests', category: 'behavioral', priority: 100 })
        ]
      });
      await saveMeta(meta);
      writeFile.mockClear();
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        if (filePath.includes('SOUL.md')) return '# Soul\n\nIdentity doc.';
        if (filePath.includes('VALUES.md')) return '# Values\n\nCore values.';
        return '';
      });
      return meta;
    };

    it('should export as system_prompt, excluding behavioral docs', async () => {
      await setupExportMeta();
      const result = await exportDigitalTwin('system_prompt');
      expect(result.format).toBe('system_prompt');
      expect(result.documentCount).toBe(2);
      expect(result.content).toContain('Identity doc');
      expect(result.content).not.toContain('behavioral');
      expect(result.tokenEstimate).toBeGreaterThan(0);
    });

    it('should export as claude_md format', async () => {
      await setupExportMeta();
      const result = await exportDigitalTwin('claude_md');
      expect(result.format).toBe('claude_md');
      expect(result.content).toContain('## Soul');
      expect(result.content).toContain('## Values');
    });

    it('should export as json format', async () => {
      await setupExportMeta();
      const result = await exportDigitalTwin('json');
      expect(result.format).toBe('json');
      const parsed = JSON.parse(result.content);
      expect(parsed.documents).toHaveLength(2);
      expect(parsed.metadata.categories).toContain('core');
    });

    it('should export as individual files', async () => {
      await setupExportMeta();
      const result = await exportDigitalTwin('individual');
      expect(result.format).toBe('individual');
      expect(result.files).toHaveLength(2);
    });

    it('should filter by document IDs when provided', async () => {
      await setupExportMeta();
      const result = await exportDigitalTwin('system_prompt', ['doc-1']);
      expect(result.documentCount).toBe(1);
    });

    it('should exclude disabled documents by default', async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', enabled: true }),
          makeDocMeta({ id: 'doc-2', filename: 'DISABLED.md', enabled: false })
        ]
      });
      await saveMeta(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return '# Content';
      });

      const result = await exportDigitalTwin('system_prompt');
      expect(result.documentCount).toBe(1);
    });

    it('should include disabled documents when includeDisabled is true', async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', enabled: true }),
          makeDocMeta({ id: 'doc-2', filename: 'DISABLED.md', enabled: false })
        ]
      });
      await saveMeta(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return '# Content';
      });

      const result = await exportDigitalTwin('system_prompt', null, true);
      expect(result.documentCount).toBe(2);
    });

    it('should throw for unknown format', async () => {
      await setupExportMeta();
      await expect(exportDigitalTwin('unknown_format')).rejects.toThrow('Unknown export format');
    });
  });

  // ==========================================================================
  // CoS Integration
  // ==========================================================================

  describe('getDigitalTwinForPrompt', () => {
    it('should return combined document content', async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', filename: 'SOUL.md', weight: 10, priority: 1 }),
          makeDocMeta({ id: 'doc-2', filename: 'VALUES.md', weight: 5, priority: 50 })
        ]
      });
      await saveMeta(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        if (filePath.includes('SOUL.md')) return 'Soul content';
        if (filePath.includes('VALUES.md')) return 'Values content';
        return '';
      });

      const result = await getDigitalTwinForPrompt();
      expect(result).toContain('Soul content');
      expect(result).toContain('Values content');
    });

    it('should return empty string when autoInjectToCoS is false', async () => {
      const meta = makeMeta({ settings: { autoInjectToCoS: false, maxContextTokens: 4000 } });
      await setupMetaFile(meta);

      const result = await getDigitalTwinForPrompt();
      expect(result).toBe('');
    });

    it('should respect maxTokens limit', async () => {
      const longContent = 'x'.repeat(20000);
      const meta = makeMeta({
        documents: [makeDocMeta({ id: 'doc-1', filename: 'BIG.md', weight: 10 })]
      });
      await saveMeta(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return longContent;
      });

      const result = await getDigitalTwinForPrompt({ maxTokens: 1000 });
      // 1000 tokens * 4 chars = 4000 chars max
      expect(result.length).toBeLessThanOrEqual(4100); // Allow small overhead for truncation message
    });

    it('should sort by weight descending then priority ascending', async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', filename: 'LOW_WEIGHT.md', weight: 1, priority: 1 }),
          makeDocMeta({ id: 'doc-2', filename: 'HIGH_WEIGHT.md', weight: 10, priority: 50 })
        ]
      });
      await saveMeta(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        if (filePath.includes('HIGH_WEIGHT.md')) return 'HIGH_WEIGHT_CONTENT';
        if (filePath.includes('LOW_WEIGHT.md')) return 'LOW_WEIGHT_CONTENT';
        return '';
      });

      const result = await getDigitalTwinForPrompt();
      // Higher weight doc should appear first
      const highIdx = result.indexOf('HIGH_WEIGHT_CONTENT');
      const lowIdx = result.indexOf('LOW_WEIGHT_CONTENT');
      expect(highIdx).toBeLessThan(lowIdx);
    });
  });

  // ==========================================================================
  // Status
  // ==========================================================================

  describe('getDigitalTwinStatus', () => {
    it('should return health score and document counts', async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', category: 'core', enabled: true }),
          makeDocMeta({ id: 'doc-2', filename: 'X.md', category: 'audio', enabled: true })
        ],
        testHistory: [{ runId: 'r1', score: 0.8 }]
      });
      await setupMetaFile(meta);

      const result = await getDigitalTwinStatus();
      expect(result).toHaveProperty('healthScore');
      expect(result.documentCount).toBe(2);
      expect(result.enabledDocuments).toBe(2);
      expect(result.documentsByCategory.core).toBe(1);
      expect(result.documentsByCategory.audio).toBe(1);
      expect(result.lastTestRun).not.toBeNull();
    });
  });

  // ==========================================================================
  // Validation & Analysis
  // ==========================================================================

  describe('validateCompleteness', () => {
    it('should detect missing sections', async () => {
      // No documents at all
      await setupMetaFile(makeMeta());

      const result = await validateCompleteness();
      expect(result.score).toBe(0);
      expect(result.missing.length).toBe(result.total);
    });

    it('should detect found sections by keywords in content', async () => {
      const meta = makeMeta({
        documents: [
          makeDocMeta({ id: 'doc-1', filename: 'IDENTITY.md', title: 'Identity', category: 'core' })
        ]
      });
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return '# Identity\n\nMy name is Test. My role is developer. I value honesty. Communication style is direct. Decision making is fast. Non-negotiable principles. Error intolerance for sloppy work.';
      });

      const result = await validateCompleteness();
      expect(result.found).toBeGreaterThan(0);
      expect(result.score).toBeGreaterThan(0);
    });

    it('should return suggestions for missing sections', async () => {
      await setupMetaFile(makeMeta());

      const result = await validateCompleteness();
      expect(result.suggestions.length).toBeGreaterThan(0);
      result.missing.forEach(m => {
        expect(m).toHaveProperty('label');
        expect(m).toHaveProperty('suggestion');
      });
    });
  });

  // ==========================================================================
  // Traits
  // ==========================================================================

  describe('getTraits', () => {
    it('should return null when no traits exist', async () => {
      await setupMetaFile(makeMeta());
      const result = await getTraits();
      expect(result).toBeNull();
    });

    it('should return traits from meta', async () => {
      const traits = { bigFive: { O: 0.8, C: 0.7 }, lastAnalyzed: '2025-01-01' };
      await setupMetaFile(makeMeta({ traits }));
      const result = await getTraits();
      expect(result.bigFive.O).toBe(0.8);
    });
  });

  describe('updateTraits', () => {
    it('should merge Big Five updates into existing traits', async () => {
      const meta = makeMeta({ traits: { bigFive: { O: 0.5, C: 0.5 } } });
      await setupMetaFile(meta);
      const emitSpy = vi.spyOn(digitalTwinEvents, 'emit');

      const result = await updateTraits({ bigFive: { O: 0.9 } });
      expect(result.bigFive.O).toBe(0.9);
      expect(result.bigFive.C).toBe(0.5);
      expect(result.analysisVersion).toBe('manual');
      expect(emitSpy).toHaveBeenCalledWith('traits:updated', expect.any(Object));
      emitSpy.mockRestore();
    });

    it('should replace values hierarchy', async () => {
      const meta = makeMeta({ traits: { valuesHierarchy: ['old'] } });
      await setupMetaFile(meta);

      const result = await updateTraits({ valuesHierarchy: ['new1', 'new2'] });
      expect(result.valuesHierarchy).toEqual(['new1', 'new2']);
    });

    it('should merge communication profile', async () => {
      const meta = makeMeta({
        traits: { communicationProfile: { formality: 3, verbosity: 7 } }
      });
      await setupMetaFile(meta);

      const result = await updateTraits({ communicationProfile: { formality: 8 } });
      expect(result.communicationProfile.formality).toBe(8);
      expect(result.communicationProfile.verbosity).toBe(7);
    });
  });

  describe('getConfidence', () => {
    it('should return null when no confidence data exists', async () => {
      await setupMetaFile(makeMeta());
      const result = await getConfidence();
      expect(result).toBeNull();
    });

    it('should return confidence from meta', async () => {
      const confidence = { overall: 0.6, dimensions: { openness: 0.8 } };
      await setupMetaFile(makeMeta({ confidence }));
      const result = await getConfidence();
      expect(result.overall).toBe(0.6);
    });
  });

  describe('getGapRecommendations', () => {
    it('should calculate confidence and return gaps when no confidence exists', async () => {
      // When no confidence, calculateConfidence is called which needs getDocuments
      await setupMetaFile(makeMeta());

      const result = await getGapRecommendations();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return existing gaps from meta', async () => {
      const gaps = [{ dimension: 'openness', confidence: 0.2 }];
      await setupMetaFile(makeMeta({ confidence: { overall: 0.3, gaps, dimensions: {} } }));

      const result = await getGapRecommendations();
      expect(result).toHaveLength(1);
      expect(result[0].dimension).toBe('openness');
    });
  });

  // ==========================================================================
  // Import Sources
  // ==========================================================================

  describe('getImportSources', () => {
    it('should return supported import sources', () => {
      const sources = getImportSources();
      expect(sources.length).toBe(4);
      const ids = sources.map(s => s.id);
      expect(ids).toContain('goodreads');
      expect(ids).toContain('spotify');
      expect(ids).toContain('letterboxd');
      expect(ids).toContain('ical');
    });

    it('should include instructions for each source', () => {
      const sources = getImportSources();
      sources.forEach(s => {
        expect(s).toHaveProperty('name');
        expect(s).toHaveProperty('format');
        expect(s).toHaveProperty('instructions');
      });
    });
  });

  // ==========================================================================
  // Import analysis — external data parsing
  // ==========================================================================

  describe('analyzeImportedData', () => {
    it('should return error for unknown source', async () => {
      const result = await analyzeImportedData('unknown', 'data', 'p1', 'm1');
      expect(result.error).toContain('Unknown import source');
    });

    it('should return error for empty Goodreads CSV', async () => {
      const result = await analyzeImportedData('goodreads', 'Title\n', 'p1', 'm1');
      expect(result.error).toContain('No books found');
    });

    it('should return error for empty Spotify data', async () => {
      safeJSONParse.mockReturnValue([]);
      const result = await analyzeImportedData('spotify', '[]', 'p1', 'm1');
      expect(result.error).toContain('No listening data found');
    });

    it('should return error for empty Letterboxd CSV', async () => {
      const result = await analyzeImportedData('letterboxd', 'Name\n', 'p1', 'm1');
      expect(result.error).toContain('No films found');
    });

    it('should return error for empty iCal data', async () => {
      const result = await analyzeImportedData('ical', 'BEGIN:VCALENDAR\nEND:VCALENDAR', 'p1', 'm1');
      expect(result.error).toContain('No events found');
    });

    it('should parse valid Goodreads CSV and call provider', async () => {
      const csv = 'Title,Author,My Rating,Date Read\n"The Great Gatsby","F. Scott Fitzgerald",5,2024/01/01\n"1984","George Orwell",4,2024/02/01';
      const mockProvider = { id: 'p1', name: 'Test', enabled: true, type: 'api', endpoint: 'http://test', timeout: 5000 };
      getProviderById.mockResolvedValue(mockProvider);
      buildPrompt.mockResolvedValue(null); // Force fallback prompt

      // Mock fetch for callProviderAI
      const originalFetch = global.fetch;
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: '```json\n{"insights": {"patterns": ["voracious reader"]}, "rawSummary": "test"}\n```' } }]
        })
      });

      safeJSONParse.mockImplementation((str, defaultValue) => {
        if (!str || typeof str !== 'string' || !str.trim()) return defaultValue;
        return JSON.parse(str);
      });

      const result = await analyzeImportedData('goodreads', csv, 'p1', 'model-1');
      expect(result.source).toBe('goodreads');
      expect(result.itemCount).toBe(2);

      global.fetch = originalFetch;
    });
  });

  // ==========================================================================
  // saveImportAsDocument
  // ==========================================================================

  describe('saveImportAsDocument', () => {
    it('should create new document when it does not exist', async () => {
      const meta = makeMeta();
      await setupMetaFile(meta);
      existsSync.mockImplementation((path) => {
        if (path.includes('READING.md')) return false;
        return true;
      });

      const result = await saveImportAsDocument('goodreads', {
        filename: 'READING.md',
        title: 'Reading Profile',
        category: 'entertainment',
        content: '# Reading\n\nBook analysis.'
      });

      expect(result.filename).toBe('READING.md');
    });

    it('should update existing document when filename matches', async () => {
      const meta = makeMeta({
        documents: [makeDocMeta({ id: 'doc-1', filename: 'READING.md', title: 'Old' })]
      });
      await saveMeta(meta);
      readFile.mockImplementation(async (filePath) => {
        if (filePath.includes('meta.json')) return JSON.stringify(meta);
        return '# Updated Reading';
      });

      const result = await saveImportAsDocument('goodreads', {
        filename: 'READING.md',
        title: 'Reading Profile',
        category: 'entertainment',
        content: '# Updated Reading'
      });

      expect(result).not.toBeNull();
    });
  });

  // ==========================================================================
  // Pure function: ENRICHMENT_CATEGORIES structure
  // ==========================================================================

  describe('ENRICHMENT_CATEGORIES', () => {
    it('should have all expected categories', () => {
      const keys = Object.keys(ENRICHMENT_CATEGORIES);
      expect(keys).toContain('core_memories');
      expect(keys).toContain('favorite_books');
      expect(keys).toContain('favorite_movies');
      expect(keys).toContain('music_taste');
      expect(keys).toContain('communication');
      expect(keys).toContain('values');
      expect(keys).toContain('personality_assessments');
    });

    it('every category should have required fields', () => {
      for (const [, config] of Object.entries(ENRICHMENT_CATEGORIES)) {
        expect(config).toHaveProperty('label');
        expect(config).toHaveProperty('description');
        expect(config).toHaveProperty('targetDoc');
        expect(config).toHaveProperty('targetCategory');
        expect(config).toHaveProperty('questions');
        expect(config.questions.length).toBeGreaterThan(0);
      }
    });
  });

  // ==========================================================================
  // SCALE_QUESTIONS structure
  // ==========================================================================

  describe('SCALE_QUESTIONS', () => {
    it('should have valid structure for all questions', () => {
      expect(SCALE_QUESTIONS.length).toBeGreaterThan(0);
      for (const q of SCALE_QUESTIONS) {
        expect(q).toHaveProperty('id');
        expect(q).toHaveProperty('text');
        expect(q).toHaveProperty('category');
        expect(q).toHaveProperty('dimension');
        expect(q).toHaveProperty('direction');
        expect(q).toHaveProperty('labels');
        expect(q.labels).toHaveLength(5);
        expect([1, -1]).toContain(q.direction);
      }
    });

    it('should have paired questions (positive and negative direction) for Big Five', () => {
      const bigFiveTraits = ['O', 'C', 'E', 'A', 'N'];
      for (const trait of bigFiveTraits) {
        const traitQuestions = SCALE_QUESTIONS.filter(q => q.trait === trait && q.traitPath?.startsWith('bigFive'));
        const positives = traitQuestions.filter(q => q.direction === 1);
        const negatives = traitQuestions.filter(q => q.direction === -1);
        expect(positives.length).toBeGreaterThan(0);
        expect(negatives.length).toBeGreaterThan(0);
      }
    });
  });
});
