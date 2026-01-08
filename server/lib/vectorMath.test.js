import { describe, it, expect } from 'vitest';
import {
  cosineSimilarity,
  euclideanDistance,
  normalize,
  findTopK,
  findAboveThreshold,
  averageVectors,
  clusterBySimilarity,
  similarityMatrix
} from './vectorMath.js';

describe('vectorMath.js', () => {
  describe('cosineSimilarity', () => {
    it('should return 1 for identical vectors', () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });

    it('should return -1 for opposite vectors', () => {
      const a = [1, 0, 0];
      const b = [-1, 0, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
    });

    it('should return 0 for orthogonal vectors', () => {
      const a = [1, 0, 0];
      const b = [0, 1, 0];
      expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
    });

    it('should return 0 for null inputs', () => {
      expect(cosineSimilarity(null, [1, 2])).toBe(0);
      expect(cosineSimilarity([1, 2], null)).toBe(0);
      expect(cosineSimilarity(null, null)).toBe(0);
    });

    it('should return 0 for undefined inputs', () => {
      expect(cosineSimilarity(undefined, [1, 2])).toBe(0);
      expect(cosineSimilarity([1, 2], undefined)).toBe(0);
    });

    it('should return 0 for vectors of different lengths', () => {
      expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    it('should return 0 for empty vectors', () => {
      expect(cosineSimilarity([], [])).toBe(0);
    });

    it('should return 0 for zero vectors', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });

    it('should handle high-dimensional vectors', () => {
      const a = Array(768).fill(0.5);
      const b = Array(768).fill(0.5);
      expect(cosineSimilarity(a, b)).toBeCloseTo(1.0);
    });
  });

  describe('euclideanDistance', () => {
    it('should return 0 for identical vectors', () => {
      const a = [1, 2, 3];
      const b = [1, 2, 3];
      expect(euclideanDistance(a, b)).toBe(0);
    });

    it('should calculate distance correctly', () => {
      const a = [0, 0];
      const b = [3, 4];
      expect(euclideanDistance(a, b)).toBe(5); // 3-4-5 triangle
    });

    it('should return Infinity for null inputs', () => {
      expect(euclideanDistance(null, [1, 2])).toBe(Infinity);
      expect(euclideanDistance([1, 2], null)).toBe(Infinity);
    });

    it('should return Infinity for different length vectors', () => {
      expect(euclideanDistance([1, 2], [1, 2, 3])).toBe(Infinity);
    });

    it('should return Infinity for empty vectors', () => {
      expect(euclideanDistance([], [])).toBe(Infinity);
    });

    it('should be commutative', () => {
      const a = [1, 2, 3];
      const b = [4, 5, 6];
      expect(euclideanDistance(a, b)).toBe(euclideanDistance(b, a));
    });
  });

  describe('normalize', () => {
    it('should normalize a vector to unit length', () => {
      const v = [3, 4];
      const normalized = normalize(v);
      const length = Math.sqrt(normalized[0] ** 2 + normalized[1] ** 2);
      expect(length).toBeCloseTo(1.0);
    });

    it('should preserve direction', () => {
      const v = [3, 4];
      const normalized = normalize(v);
      expect(normalized[0] / normalized[1]).toBeCloseTo(3 / 4);
    });

    it('should return empty array for null/undefined', () => {
      expect(normalize(null)).toEqual([]);
      expect(normalize(undefined)).toEqual([]);
    });

    it('should return empty array for empty vector', () => {
      expect(normalize([])).toEqual([]);
    });

    it('should return zero vector for zero input', () => {
      const result = normalize([0, 0, 0]);
      expect(result).toEqual([0, 0, 0]);
    });

    it('should handle single-element vectors', () => {
      const result = normalize([5]);
      expect(result).toEqual([1]);
    });
  });

  describe('findTopK', () => {
    it('should find the top K most similar vectors', () => {
      const query = [1, 0, 0];
      const vectors = {
        'a': [1, 0, 0],       // similarity: 1.0
        'b': [0.9, 0.1, 0],   // similarity: ~0.99
        'c': [0, 1, 0],       // similarity: 0
        'd': [-1, 0, 0]       // similarity: -1.0
      };

      const results = findTopK(query, vectors, 2);

      expect(results).toHaveLength(2);
      expect(results[0].id).toBe('a');
      expect(results[0].similarity).toBeCloseTo(1.0);
      expect(results[1].id).toBe('b');
    });

    it('should return empty array for null query', () => {
      expect(findTopK(null, { a: [1, 2] }, 5)).toEqual([]);
    });

    it('should return empty array for null vectors', () => {
      expect(findTopK([1, 2], null, 5)).toEqual([]);
    });

    it('should return empty array for empty vectors', () => {
      expect(findTopK([1, 2], {}, 5)).toEqual([]);
    });

    it('should return all vectors if k > vector count', () => {
      const query = [1, 0];
      const vectors = { 'a': [1, 0], 'b': [0, 1] };
      const results = findTopK(query, vectors, 10);
      expect(results).toHaveLength(2);
    });

    it('should default k to 10', () => {
      const query = [1, 0];
      const vectors = {};
      for (let i = 0; i < 15; i++) {
        vectors[`v${i}`] = [1, 0];
      }
      const results = findTopK(query, vectors);
      expect(results).toHaveLength(10);
    });
  });

  describe('findAboveThreshold', () => {
    it('should find vectors above similarity threshold', () => {
      const query = [1, 0, 0];
      const vectors = {
        'a': [1, 0, 0],       // similarity: 1.0
        'b': [0.9, 0.1, 0],   // similarity: ~0.99
        'c': [0.5, 0.5, 0],   // similarity: ~0.71
        'd': [0, 1, 0]        // similarity: 0
      };

      const results = findAboveThreshold(query, vectors, 0.8);

      expect(results.length).toBe(2);
      expect(results.every(r => r.similarity >= 0.8)).toBe(true);
    });

    it('should return sorted by similarity descending', () => {
      const query = [1, 0];
      const vectors = {
        'a': [0.8, 0.2],
        'b': [1, 0],
        'c': [0.9, 0.1]
      };

      const results = findAboveThreshold(query, vectors, 0.5);

      for (let i = 0; i < results.length - 1; i++) {
        expect(results[i].similarity).toBeGreaterThanOrEqual(results[i + 1].similarity);
      }
    });

    it('should return empty for null inputs', () => {
      expect(findAboveThreshold(null, { a: [1] }, 0.5)).toEqual([]);
      expect(findAboveThreshold([1], null, 0.5)).toEqual([]);
    });

    it('should return empty for empty vectors', () => {
      expect(findAboveThreshold([1, 2], {}, 0.5)).toEqual([]);
    });

    it('should default threshold to 0.7', () => {
      const query = [1, 0];
      const vectors = {
        'a': [1, 0],        // 1.0
        'b': [0.6, 0.4]     // ~0.83
      };
      const results = findAboveThreshold(query, vectors);
      expect(results.length).toBe(2);
    });
  });

  describe('averageVectors', () => {
    it('should calculate average of vectors', () => {
      const vectors = [
        [1, 2, 3],
        [3, 2, 1],
        [2, 2, 2]
      ];
      const avg = averageVectors(vectors);
      expect(avg).toEqual([2, 2, 2]);
    });

    it('should return empty for null input', () => {
      expect(averageVectors(null)).toEqual([]);
    });

    it('should return empty for empty array', () => {
      expect(averageVectors([])).toEqual([]);
    });

    it('should handle single vector', () => {
      const vectors = [[1, 2, 3]];
      const avg = averageVectors(vectors);
      expect(avg).toEqual([1, 2, 3]);
    });

    it('should handle decimal results', () => {
      const vectors = [
        [1, 0],
        [0, 1]
      ];
      const avg = averageVectors(vectors);
      expect(avg[0]).toBeCloseTo(0.5);
      expect(avg[1]).toBeCloseTo(0.5);
    });
  });

  describe('clusterBySimilarity', () => {
    it('should cluster similar items together', () => {
      const items = [
        { id: 'a', embedding: [1, 0, 0] },
        { id: 'b', embedding: [0.99, 0.01, 0] },
        { id: 'c', embedding: [0, 1, 0] },
        { id: 'd', embedding: [0.01, 0.99, 0] }
      ];

      const clusters = clusterBySimilarity(items, 0.95);

      expect(clusters.length).toBe(2);
      const clusterA = clusters.find(c => c.some(i => i.id === 'a'));
      const clusterC = clusters.find(c => c.some(i => i.id === 'c'));
      expect(clusterA.some(i => i.id === 'b')).toBe(true);
      expect(clusterC.some(i => i.id === 'd')).toBe(true);
    });

    it('should return empty for null input', () => {
      expect(clusterBySimilarity(null)).toEqual([]);
    });

    it('should return empty for empty array', () => {
      expect(clusterBySimilarity([])).toEqual([]);
    });

    it('should put each item in its own cluster if all dissimilar', () => {
      const items = [
        { id: 'a', embedding: [1, 0, 0] },
        { id: 'b', embedding: [0, 1, 0] },
        { id: 'c', embedding: [0, 0, 1] }
      ];

      const clusters = clusterBySimilarity(items, 0.99);
      expect(clusters.length).toBe(3);
    });

    it('should use default threshold of 0.9', () => {
      const items = [
        { id: 'a', embedding: [1, 0] },
        { id: 'b', embedding: [0.95, 0.05] }
      ];
      const clusters = clusterBySimilarity(items);
      expect(clusters.length).toBe(1);
    });
  });

  describe('similarityMatrix', () => {
    it('should compute pairwise similarity matrix', () => {
      const vectors = {
        'a': [1, 0],
        'b': [0, 1],
        'c': [1, 0]
      };

      const { ids, matrix } = similarityMatrix(vectors);

      expect(ids).toHaveLength(3);
      expect(matrix).toHaveLength(3);
      expect(matrix[0]).toHaveLength(3);

      // Diagonal should be 1
      for (let i = 0; i < ids.length; i++) {
        expect(matrix[i][i]).toBe(1);
      }
    });

    it('should be symmetric', () => {
      const vectors = {
        'a': [1, 0],
        'b': [0.5, 0.5],
        'c': [0, 1]
      };

      const { matrix } = similarityMatrix(vectors);

      for (let i = 0; i < matrix.length; i++) {
        for (let j = 0; j < matrix.length; j++) {
          expect(matrix[i][j]).toBeCloseTo(matrix[j][i]);
        }
      }
    });

    it('should handle single vector', () => {
      const vectors = { 'a': [1, 0] };
      const { ids, matrix } = similarityMatrix(vectors);

      expect(ids).toEqual(['a']);
      expect(matrix).toEqual([[1]]);
    });

    it('should handle empty vectors object', () => {
      const { ids, matrix } = similarityMatrix({});
      expect(ids).toEqual([]);
      expect(matrix).toEqual([]);
    });
  });
});
