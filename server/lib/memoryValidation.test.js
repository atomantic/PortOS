import { describe, it, expect } from 'vitest';
import {
  memoryTypeEnum,
  memoryStatusEnum,
  memoryCategoryEnum,
  memoryCreateSchema,
  memorySchema,
  memoryUpdateSchema,
  memorySearchSchema,
  memoryListSchema,
  memoryTimelineSchema,
  memoryExtractSchema,
  memoryConsolidateSchema,
  memoryLinkSchema
} from './memoryValidation.js';

describe('memoryValidation.js', () => {
  describe('memoryTypeEnum', () => {
    it('should accept valid memory types', () => {
      expect(memoryTypeEnum.safeParse('fact').success).toBe(true);
      expect(memoryTypeEnum.safeParse('learning').success).toBe(true);
      expect(memoryTypeEnum.safeParse('observation').success).toBe(true);
      expect(memoryTypeEnum.safeParse('decision').success).toBe(true);
      expect(memoryTypeEnum.safeParse('preference').success).toBe(true);
      expect(memoryTypeEnum.safeParse('context').success).toBe(true);
    });

    it('should reject invalid types', () => {
      expect(memoryTypeEnum.safeParse('invalid').success).toBe(false);
      expect(memoryTypeEnum.safeParse('').success).toBe(false);
    });
  });

  describe('memoryStatusEnum', () => {
    it('should accept valid statuses', () => {
      expect(memoryStatusEnum.safeParse('active').success).toBe(true);
      expect(memoryStatusEnum.safeParse('archived').success).toBe(true);
      expect(memoryStatusEnum.safeParse('expired').success).toBe(true);
      expect(memoryStatusEnum.safeParse('pending_approval').success).toBe(true);
    });

    it('should reject invalid statuses', () => {
      expect(memoryStatusEnum.safeParse('deleted').success).toBe(false);
    });
  });

  describe('memoryCategoryEnum', () => {
    it('should accept valid categories', () => {
      expect(memoryCategoryEnum.safeParse('codebase').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('workflow').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('tools').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('architecture').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('patterns').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('conventions').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('preferences').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('system').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('project').success).toBe(true);
      expect(memoryCategoryEnum.safeParse('other').success).toBe(true);
    });
  });

  describe('memoryCreateSchema', () => {
    it('should validate minimal memory creation', () => {
      const memory = {
        type: 'fact',
        content: 'The sky is blue'
      };
      const result = memoryCreateSchema.safeParse(memory);
      expect(result.success).toBe(true);
      expect(result.data.category).toBe('other');
      expect(result.data.confidence).toBe(0.8);
      expect(result.data.importance).toBe(0.5);
    });

    it('should validate complete memory creation', () => {
      const memory = {
        type: 'learning',
        content: 'React hooks are easier than class components',
        summary: 'React hooks preferred',
        category: 'patterns',
        tags: ['react', 'frontend'],
        confidence: 0.95,
        importance: 0.8,
        relatedMemories: ['550e8400-e29b-41d4-a716-446655440000'],
        sourceTaskId: 'task-123',
        sourceAgentId: 'agent-456',
        sourceAppId: 'app-789'
      };
      const result = memoryCreateSchema.safeParse(memory);
      expect(result.success).toBe(true);
    });

    it('should reject empty content', () => {
      const memory = { type: 'fact', content: '' };
      expect(memoryCreateSchema.safeParse(memory).success).toBe(false);
    });

    it('should reject content over 10240 characters', () => {
      const memory = { type: 'fact', content: 'a'.repeat(10241) };
      expect(memoryCreateSchema.safeParse(memory).success).toBe(false);
    });

    it('should reject summary over 500 characters', () => {
      const memory = {
        type: 'fact',
        content: 'test',
        summary: 'a'.repeat(501)
      };
      expect(memoryCreateSchema.safeParse(memory).success).toBe(false);
    });

    it('should reject more than 20 tags', () => {
      const memory = {
        type: 'fact',
        content: 'test',
        tags: Array(21).fill('tag')
      };
      expect(memoryCreateSchema.safeParse(memory).success).toBe(false);
    });

    it('should reject tag over 50 characters', () => {
      const memory = {
        type: 'fact',
        content: 'test',
        tags: ['a'.repeat(51)]
      };
      expect(memoryCreateSchema.safeParse(memory).success).toBe(false);
    });

    it('should reject confidence outside 0-1', () => {
      expect(memoryCreateSchema.safeParse({
        type: 'fact', content: 'test', confidence: -0.1
      }).success).toBe(false);
      expect(memoryCreateSchema.safeParse({
        type: 'fact', content: 'test', confidence: 1.1
      }).success).toBe(false);
    });

    it('should reject importance outside 0-1', () => {
      expect(memoryCreateSchema.safeParse({
        type: 'fact', content: 'test', importance: -0.1
      }).success).toBe(false);
      expect(memoryCreateSchema.safeParse({
        type: 'fact', content: 'test', importance: 1.1
      }).success).toBe(false);
    });

    it('should reject invalid UUIDs in relatedMemories', () => {
      const memory = {
        type: 'fact',
        content: 'test',
        relatedMemories: ['not-a-uuid']
      };
      expect(memoryCreateSchema.safeParse(memory).success).toBe(false);
    });

    it('should allow null sourceAppId', () => {
      const memory = {
        type: 'fact',
        content: 'test',
        sourceAppId: null
      };
      const result = memoryCreateSchema.safeParse(memory);
      expect(result.success).toBe(true);
    });
  });

  describe('memorySchema', () => {
    it('should validate a complete memory with system fields', () => {
      const memory = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'fact',
        content: 'Test content',
        embedding: [0.1, 0.2, 0.3],
        embeddingModel: 'text-embedding-3-small',
        accessCount: 5,
        lastAccessed: '2026-01-15T10:00:00.000Z',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-15T10:00:00.000Z',
        expiresAt: null,
        status: 'active'
      };
      const result = memorySchema.safeParse(memory);
      expect(result.success).toBe(true);
    });

    it('should apply default status', () => {
      const memory = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'fact',
        content: 'Test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      const result = memorySchema.safeParse(memory);
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('active');
    });

    it('should reject negative accessCount', () => {
      const memory = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        type: 'fact',
        content: 'Test',
        accessCount: -1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(memorySchema.safeParse(memory).success).toBe(false);
    });
  });

  describe('memoryUpdateSchema', () => {
    it('should allow partial updates', () => {
      const update = { content: 'Updated content' };
      const result = memoryUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
    });

    it('should allow empty object', () => {
      const result = memoryUpdateSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should allow status update', () => {
      const update = { status: 'archived' };
      const result = memoryUpdateSchema.safeParse(update);
      expect(result.success).toBe(true);
    });

    it('should validate provided fields', () => {
      const update = { content: '' };
      expect(memoryUpdateSchema.safeParse(update).success).toBe(false);
    });
  });

  describe('memorySearchSchema', () => {
    it('should validate search query', () => {
      const search = { query: 'react hooks' };
      const result = memorySearchSchema.safeParse(search);
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('active');
      expect(result.data.minRelevance).toBe(0.7);
      expect(result.data.limit).toBe(20);
    });

    it('should validate full search options', () => {
      const search = {
        query: 'react patterns',
        types: ['learning', 'fact'],
        categories: ['patterns', 'codebase'],
        tags: ['react'],
        status: 'active',
        minRelevance: 0.8,
        limit: 50,
        offset: 10
      };
      const result = memorySearchSchema.safeParse(search);
      expect(result.success).toBe(true);
    });

    it('should reject empty query', () => {
      expect(memorySearchSchema.safeParse({ query: '' }).success).toBe(false);
    });

    it('should reject query over 1000 characters', () => {
      expect(memorySearchSchema.safeParse({ query: 'a'.repeat(1001) }).success).toBe(false);
    });

    it('should reject minRelevance outside 0-1', () => {
      expect(memorySearchSchema.safeParse({
        query: 'test', minRelevance: 1.5
      }).success).toBe(false);
    });

    it('should reject limit over 100', () => {
      expect(memorySearchSchema.safeParse({
        query: 'test', limit: 101
      }).success).toBe(false);
    });
  });

  describe('memoryListSchema', () => {
    it('should apply defaults', () => {
      const result = memoryListSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.status).toBe('active');
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
      expect(result.data.sortBy).toBe('createdAt');
      expect(result.data.sortOrder).toBe('desc');
    });

    it('should validate custom sorting', () => {
      const list = {
        sortBy: 'importance',
        sortOrder: 'asc'
      };
      const result = memoryListSchema.safeParse(list);
      expect(result.success).toBe(true);
    });

    it('should reject invalid sortBy', () => {
      expect(memoryListSchema.safeParse({ sortBy: 'invalid' }).success).toBe(false);
    });

    it('should reject invalid sortOrder', () => {
      expect(memoryListSchema.safeParse({ sortOrder: 'random' }).success).toBe(false);
    });
  });

  describe('memoryTimelineSchema', () => {
    it('should apply default limit', () => {
      const result = memoryTimelineSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(100);
    });

    it('should validate date range', () => {
      const timeline = {
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31T23:59:59.000Z',
        types: ['fact', 'learning']
      };
      const result = memoryTimelineSchema.safeParse(timeline);
      expect(result.success).toBe(true);
    });

    it('should reject limit over 500', () => {
      expect(memoryTimelineSchema.safeParse({ limit: 501 }).success).toBe(false);
    });
  });

  describe('memoryExtractSchema', () => {
    it('should validate extraction request', () => {
      const extract = {
        agentId: 'agent-123',
        taskId: 'task-456',
        output: 'Agent completed the task with these findings...'
      };
      const result = memoryExtractSchema.safeParse(extract);
      expect(result.success).toBe(true);
    });

    it('should require all fields', () => {
      expect(memoryExtractSchema.safeParse({ agentId: 'test' }).success).toBe(false);
      expect(memoryExtractSchema.safeParse({ taskId: 'test' }).success).toBe(false);
      expect(memoryExtractSchema.safeParse({ output: 'test' }).success).toBe(false);
    });

    it('should reject empty output', () => {
      const extract = {
        agentId: 'agent-123',
        taskId: 'task-456',
        output: ''
      };
      expect(memoryExtractSchema.safeParse(extract).success).toBe(false);
    });
  });

  describe('memoryConsolidateSchema', () => {
    it('should apply defaults', () => {
      const result = memoryConsolidateSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.similarityThreshold).toBe(0.9);
      expect(result.data.dryRun).toBe(false);
    });

    it('should validate custom threshold', () => {
      const consolidate = { similarityThreshold: 0.85, dryRun: true };
      const result = memoryConsolidateSchema.safeParse(consolidate);
      expect(result.success).toBe(true);
    });

    it('should reject threshold below 0.5', () => {
      expect(memoryConsolidateSchema.safeParse({ similarityThreshold: 0.4 }).success).toBe(false);
    });

    it('should reject threshold above 1', () => {
      expect(memoryConsolidateSchema.safeParse({ similarityThreshold: 1.1 }).success).toBe(false);
    });
  });

  describe('memoryLinkSchema', () => {
    it('should validate link request', () => {
      const link = {
        sourceId: '550e8400-e29b-41d4-a716-446655440000',
        targetId: '550e8400-e29b-41d4-a716-446655440001'
      };
      const result = memoryLinkSchema.safeParse(link);
      expect(result.success).toBe(true);
    });

    it('should reject invalid UUIDs', () => {
      expect(memoryLinkSchema.safeParse({
        sourceId: 'not-uuid', targetId: '550e8400-e29b-41d4-a716-446655440000'
      }).success).toBe(false);
      expect(memoryLinkSchema.safeParse({
        sourceId: '550e8400-e29b-41d4-a716-446655440000', targetId: 'not-uuid'
      }).success).toBe(false);
    });

    it('should require both fields', () => {
      expect(memoryLinkSchema.safeParse({
        sourceId: '550e8400-e29b-41d4-a716-446655440000'
      }).success).toBe(false);
    });
  });
});
