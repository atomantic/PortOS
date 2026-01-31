import { describe, it, expect } from 'vitest';
import {
  tokenize,
  calculateIDF,
  buildInvertedIndex,
  addDocument,
  removeDocument,
  score,
  search,
  createEmptyIndex,
  serializeIndex,
  deserializeIndex,
  getIndexStats,
  STOP_WORDS
} from './bm25.js';

describe('BM25 Algorithm', () => {
  describe('tokenize', () => {
    it('should tokenize text into lowercase terms', () => {
      const result = tokenize('Hello World');
      expect(result).toContain('hello');
      expect(result).toContain('world');
    });

    it('should remove punctuation', () => {
      const result = tokenize('Hello, World! How are you?');
      expect(result.every(t => !/[,!?]/.test(t))).toBe(true);
    });

    it('should remove single character tokens', () => {
      const result = tokenize('I am a test');
      expect(result).not.toContain('i');
      expect(result).not.toContain('a');
    });

    it('should remove stop words', () => {
      const result = tokenize('the quick brown fox jumps over the lazy dog');
      expect(result).not.toContain('the');
      expect(result).not.toContain('is');
      expect(result).toContain('quick');
      expect(result).toContain('brown');
      expect(result).toContain('fox');
      expect(result).toContain('over'); // 'over' is not a stop word in our list
    });

    it('should handle empty input', () => {
      expect(tokenize('')).toEqual([]);
      expect(tokenize(null)).toEqual([]);
      expect(tokenize(undefined)).toEqual([]);
    });

    it('should handle non-string input', () => {
      expect(tokenize(123)).toEqual([]);
      expect(tokenize({})).toEqual([]);
    });
  });

  describe('calculateIDF', () => {
    it('should return 0 when n is 0', () => {
      expect(calculateIDF(100, 0)).toBe(0);
    });

    it('should return 0 when N is 0', () => {
      expect(calculateIDF(0, 5)).toBe(0);
    });

    it('should return higher values for rarer terms', () => {
      const commonIDF = calculateIDF(1000, 500);
      const rareIDF = calculateIDF(1000, 10);
      expect(rareIDF).toBeGreaterThan(commonIDF);
    });

    it('should return positive values for valid inputs', () => {
      expect(calculateIDF(100, 10)).toBeGreaterThan(0);
    });
  });

  describe('buildInvertedIndex', () => {
    it('should build index from documents', () => {
      const docs = [
        { id: 'doc1', text: 'quick brown fox' },
        { id: 'doc2', text: 'lazy brown dog' }
      ];
      const index = buildInvertedIndex(docs);

      expect(index.totalDocs).toBe(2);
      expect(index.docIds.has('doc1')).toBe(true);
      expect(index.docIds.has('doc2')).toBe(true);
      expect(index.terms['brown'].docFreq).toBe(2);
      expect(index.terms['quick'].docFreq).toBe(1);
    });

    it('should track document lengths', () => {
      const docs = [
        { id: 'doc1', text: 'word word word' },
        { id: 'doc2', text: 'single' }
      ];
      const index = buildInvertedIndex(docs);

      // Document length is total term count (including duplicates)
      expect(index.docLengths['doc1']).toBe(3); // "word" appears 3 times
      expect(index.docLengths['doc2']).toBe(1);
    });

    it('should calculate average document length', () => {
      const docs = [
        { id: 'doc1', text: 'quick brown fox jumps' },
        { id: 'doc2', text: 'lazy dog' }
      ];
      const index = buildInvertedIndex(docs);

      expect(index.avgDocLength).toBeGreaterThan(0);
    });

    it('should handle empty documents array', () => {
      const index = buildInvertedIndex([]);
      expect(index.totalDocs).toBe(0);
      expect(index.avgDocLength).toBe(0);
    });

    it('should skip documents without id or text', () => {
      const docs = [
        { id: 'doc1', text: 'valid document' },
        { text: 'no id' },
        { id: 'doc3' },
        {}
      ];
      const index = buildInvertedIndex(docs);

      expect(index.totalDocs).toBe(1);
    });
  });

  describe('addDocument', () => {
    it('should add a document to existing index', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'hello world');

      expect(index.totalDocs).toBe(1);
      expect(index.docIds.has('doc1')).toBe(true);
    });

    it('should update average doc length', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'word word word');
      const avgAfterFirst = index.avgDocLength;

      addDocument(index, 'doc2', 'single');
      expect(index.avgDocLength).not.toBe(avgAfterFirst);
    });

    it('should replace existing document with same id', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'original content');
      addDocument(index, 'doc1', 'updated content');

      expect(index.totalDocs).toBe(1);
      expect(index.terms['updated']).toBeDefined();
    });

    it('should handle empty text', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', '');

      expect(index.totalDocs).toBe(0);
    });
  });

  describe('removeDocument', () => {
    it('should remove a document from index', () => {
      const docs = [
        { id: 'doc1', text: 'quick brown fox' },
        { id: 'doc2', text: 'lazy brown dog' }
      ];
      const index = buildInvertedIndex(docs);

      removeDocument(index, 'doc1');

      expect(index.totalDocs).toBe(1);
      expect(index.docIds.has('doc1')).toBe(false);
      expect(index.terms['quick']).toBeUndefined();
    });

    it('should update term frequencies', () => {
      const docs = [
        { id: 'doc1', text: 'brown' },
        { id: 'doc2', text: 'brown' }
      ];
      const index = buildInvertedIndex(docs);

      expect(index.terms['brown'].docFreq).toBe(2);
      removeDocument(index, 'doc1');
      expect(index.terms['brown'].docFreq).toBe(1);
    });

    it('should handle non-existent document', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'test');

      removeDocument(index, 'nonexistent');
      expect(index.totalDocs).toBe(1);
    });
  });

  describe('score', () => {
    it('should return 0 for non-existent document', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'test document');

      expect(score('test', 'nonexistent', index)).toBe(0);
    });

    it('should return higher score for more matches', () => {
      const docs = [
        { id: 'doc1', text: 'quick brown fox' },
        { id: 'doc2', text: 'quick quick quick' }
      ];
      const index = buildInvertedIndex(docs);

      const score1 = score('quick', 'doc1', index);
      const score2 = score('quick', 'doc2', index);

      expect(score2).toBeGreaterThan(score1);
    });

    it('should return 0 when no query terms match', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'hello world');

      expect(score('xyz', 'doc1', index)).toBe(0);
    });
  });

  describe('search', () => {
    it('should return ranked results', () => {
      const docs = [
        { id: 'doc1', text: 'python programming language' },
        { id: 'doc2', text: 'javascript programming web' },
        { id: 'doc3', text: 'python python python scripts' }
      ];
      const index = buildInvertedIndex(docs);

      const results = search('python programming', index);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0].score).toBeGreaterThanOrEqual(results[results.length - 1].score);
    });

    it('should respect limit parameter', () => {
      const docs = Array.from({ length: 20 }, (_, i) => ({
        id: `doc${i}`,
        text: `document ${i} content test`
      }));
      const index = buildInvertedIndex(docs);

      const results = search('content', index, { limit: 5 });
      expect(results.length).toBe(5);
    });

    it('should respect threshold parameter', () => {
      const docs = [
        { id: 'doc1', text: 'exact match query' },
        { id: 'doc2', text: 'partial match' }
      ];
      const index = buildInvertedIndex(docs);

      const allResults = search('exact match', index, { threshold: 0 });
      const highResults = search('exact match', index, { threshold: 1.0 });

      expect(highResults.length).toBeLessThanOrEqual(allResults.length);
    });

    it('should return empty array for empty query', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'test document');

      expect(search('', index)).toEqual([]);
    });

    it('should return empty array for stop-word-only query', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'test document');

      expect(search('the and is', index)).toEqual([]);
    });
  });

  describe('serialization', () => {
    it('should serialize index with Set to Array', () => {
      const index = createEmptyIndex();
      addDocument(index, 'doc1', 'test');

      const serialized = serializeIndex(index);
      expect(Array.isArray(serialized.docIds)).toBe(true);
    });

    it('should deserialize index back to usable form', () => {
      const original = createEmptyIndex();
      addDocument(original, 'doc1', 'test document');
      addDocument(original, 'doc2', 'another test');

      const serialized = serializeIndex(original);
      const deserialized = deserializeIndex(serialized);

      expect(deserialized.docIds instanceof Set).toBe(true);
      expect(deserialized.docIds.has('doc1')).toBe(true);
      expect(deserialized.docIds.has('doc2')).toBe(true);
      expect(deserialized.totalDocs).toBe(2);
    });

    it('should handle null data in deserialize', () => {
      const result = deserializeIndex(null);
      expect(result.totalDocs).toBe(0);
      expect(result.docIds instanceof Set).toBe(true);
    });
  });

  describe('getIndexStats', () => {
    it('should return correct statistics', () => {
      const docs = [
        { id: 'doc1', text: 'hello world test' },
        { id: 'doc2', text: 'another test document' },
        { id: 'doc3', text: 'third document here' }
      ];
      const index = buildInvertedIndex(docs);
      const stats = getIndexStats(index);

      expect(stats.totalDocuments).toBe(3);
      expect(stats.totalTerms).toBeGreaterThan(0);
      expect(stats.avgDocumentLength).toBeGreaterThan(0);
    });
  });

  describe('STOP_WORDS', () => {
    it('should be a Set', () => {
      expect(STOP_WORDS instanceof Set).toBe(true);
    });

    it('should contain common English stop words', () => {
      expect(STOP_WORDS.has('the')).toBe(true);
      expect(STOP_WORDS.has('and')).toBe(true);
      expect(STOP_WORDS.has('is')).toBe(true);
    });
  });
});
