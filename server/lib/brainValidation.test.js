import { describe, it, expect } from 'vitest';
import {
  destinationEnum,
  projectStatusEnum,
  ideaStatusEnum,
  adminStatusEnum,
  inboxStatusEnum,
  aiConfigSchema,
  classificationSchema,
  filedSchema,
  correctionSchema,
  inboxLogRecordSchema,
  peopleRecordSchema,
  projectRecordSchema,
  ideaRecordSchema,
  adminRecordSchema,
  brainSettingsSchema,
  captureInputSchema,
  resolveReviewInputSchema,
  fixInputSchema,
  updateInboxInputSchema,
  peopleInputSchema,
  projectInputSchema,
  ideaInputSchema,
  adminInputSchema,
  inboxQuerySchema,
  linkRecordSchema,
  linkInputSchema,
  linkUpdateInputSchema,
  linkReorderSchema,
  linksQuerySchema,
  bucketInputSchema,
  bucketUpdateInputSchema,
  bucketReorderSchema,
  brainSyncQuerySchema,
  brainSyncPushSchema
} from './brainValidation.js';

describe('brainValidation.js', () => {
  describe('destinationEnum', () => {
    it('should accept valid destinations', () => {
      expect(destinationEnum.safeParse('people').success).toBe(true);
      expect(destinationEnum.safeParse('projects').success).toBe(true);
      expect(destinationEnum.safeParse('ideas').success).toBe(true);
      expect(destinationEnum.safeParse('admin').success).toBe(true);
      expect(destinationEnum.safeParse('unknown').success).toBe(true);
    });

    it('should reject invalid destinations', () => {
      expect(destinationEnum.safeParse('invalid').success).toBe(false);
      expect(destinationEnum.safeParse('').success).toBe(false);
    });
  });

  describe('projectStatusEnum', () => {
    it('should accept valid statuses', () => {
      expect(projectStatusEnum.safeParse('active').success).toBe(true);
      expect(projectStatusEnum.safeParse('waiting').success).toBe(true);
      expect(projectStatusEnum.safeParse('blocked').success).toBe(true);
      expect(projectStatusEnum.safeParse('someday').success).toBe(true);
      expect(projectStatusEnum.safeParse('done').success).toBe(true);
    });

    it('should reject invalid statuses', () => {
      expect(projectStatusEnum.safeParse('invalid').success).toBe(false);
    });
  });

  describe('aiConfigSchema', () => {
    it('should validate a complete AI config', () => {
      const config = {
        providerId: 'openai',
        modelId: 'gpt-4',
        promptTemplateId: 'classify-v1',
        temperature: 0.7,
        maxTokens: 1000
      };
      const result = aiConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('should validate with minimal required fields', () => {
      const config = {
        providerId: 'openai',
        modelId: 'gpt-4',
        promptTemplateId: 'classify-v1'
      };
      const result = aiConfigSchema.safeParse(config);
      expect(result.success).toBe(true);
    });

    it('should reject temperature outside 0-2 range', () => {
      const config = {
        providerId: 'test',
        modelId: 'test',
        promptTemplateId: 'test',
        temperature: 3
      };
      expect(aiConfigSchema.safeParse(config).success).toBe(false);
    });

    it('should reject negative maxTokens', () => {
      const config = {
        providerId: 'test',
        modelId: 'test',
        promptTemplateId: 'test',
        maxTokens: -1
      };
      expect(aiConfigSchema.safeParse(config).success).toBe(false);
    });
  });

  describe('classificationSchema', () => {
    it('should validate a classification result', () => {
      const classification = {
        destination: 'projects',
        confidence: 0.85,
        title: 'New project idea',
        extracted: { name: 'Test Project' },
        reasons: ['Has clear next actions']
      };
      const result = classificationSchema.safeParse(classification);
      expect(result.success).toBe(true);
    });

    it('should reject confidence outside 0-1 range', () => {
      const classification = {
        destination: 'projects',
        confidence: 1.5,
        title: 'Test',
        extracted: {}
      };
      expect(classificationSchema.safeParse(classification).success).toBe(false);
    });

    it('should reject empty title', () => {
      const classification = {
        destination: 'projects',
        confidence: 0.8,
        title: '',
        extracted: {}
      };
      expect(classificationSchema.safeParse(classification).success).toBe(false);
    });

    it('should reject title over 200 characters', () => {
      const classification = {
        destination: 'projects',
        confidence: 0.8,
        title: 'a'.repeat(201),
        extracted: {}
      };
      expect(classificationSchema.safeParse(classification).success).toBe(false);
    });

    it('should reject more than 5 reasons', () => {
      const classification = {
        destination: 'projects',
        confidence: 0.8,
        title: 'Test',
        extracted: {},
        reasons: ['1', '2', '3', '4', '5', '6']
      };
      expect(classificationSchema.safeParse(classification).success).toBe(false);
    });
  });

  describe('filedSchema', () => {
    it('should validate filed info with valid destination', () => {
      const filed = {
        destination: 'projects',
        destinationId: '550e8400-e29b-41d4-a716-446655440000'
      };
      const result = filedSchema.safeParse(filed);
      expect(result.success).toBe(true);
    });

    it('should reject unknown destination', () => {
      const filed = {
        destination: 'unknown',
        destinationId: '550e8400-e29b-41d4-a716-446655440000'
      };
      expect(filedSchema.safeParse(filed).success).toBe(false);
    });

    it('should reject invalid UUID', () => {
      const filed = {
        destination: 'projects',
        destinationId: 'not-a-uuid'
      };
      expect(filedSchema.safeParse(filed).success).toBe(false);
    });
  });

  describe('correctionSchema', () => {
    it('should validate a correction', () => {
      const correction = {
        correctedAt: '2026-01-01T00:00:00.000Z',
        previousDestination: 'ideas',
        newDestination: 'projects',
        note: 'Actually a concrete project'
      };
      const result = correctionSchema.safeParse(correction);
      expect(result.success).toBe(true);
    });

    it('should reject unknown as newDestination', () => {
      const correction = {
        correctedAt: '2026-01-01T00:00:00.000Z',
        previousDestination: 'ideas',
        newDestination: 'unknown'
      };
      expect(correctionSchema.safeParse(correction).success).toBe(false);
    });

    it('should reject note over 500 characters', () => {
      const correction = {
        correctedAt: '2026-01-01T00:00:00.000Z',
        previousDestination: 'ideas',
        newDestination: 'projects',
        note: 'a'.repeat(501)
      };
      expect(correctionSchema.safeParse(correction).success).toBe(false);
    });
  });

  describe('peopleRecordSchema', () => {
    it('should validate a complete people record', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'John Doe',
        context: 'Met at conference',
        followUps: ['Send article', 'Schedule call'],
        lastTouched: '2026-01-15T10:00:00.000Z',
        tags: ['work', 'networking'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-15T10:00:00.000Z'
      };
      const result = peopleRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should reject empty name', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(peopleRecordSchema.safeParse(record).success).toBe(false);
    });

    it('should reject name over 200 characters', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'a'.repeat(201),
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(peopleRecordSchema.safeParse(record).success).toBe(false);
    });
  });

  describe('projectRecordSchema', () => {
    it('should validate a complete project record', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'New Project',
        status: 'active',
        nextAction: 'Review requirements',
        notes: 'Project notes here',
        tags: ['priority'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      const result = projectRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should require nextAction', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test Project',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(projectRecordSchema.safeParse(record).success).toBe(false);
    });

    it('should reject empty nextAction', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        name: 'Test Project',
        status: 'active',
        nextAction: '',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(projectRecordSchema.safeParse(record).success).toBe(false);
    });
  });

  describe('ideaRecordSchema', () => {
    it('should validate an idea record', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Great Idea',
        status: 'active',
        oneLiner: 'A brief description of the idea',
        notes: 'Extended notes',
        tags: ['brainstorm'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      const result = ideaRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should require oneLiner', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Test Idea',
        status: 'active',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(ideaRecordSchema.safeParse(record).success).toBe(false);
    });
  });

  describe('adminRecordSchema', () => {
    it('should validate an admin record', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Admin Task',
        status: 'open',
        dueDate: '2026-02-01T00:00:00.000Z',
        nextAction: 'Complete paperwork',
        notes: 'Important deadline',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      const result = adminRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should allow optional fields', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        title: 'Simple Admin',
        status: 'done',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      const result = adminRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });
  });

  describe('brainSettingsSchema', () => {
    it('should apply defaults', () => {
      const result = brainSettingsSchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.version).toBe(1);
      expect(result.data.confidenceThreshold).toBe(0.6);
      expect(result.data.dailyDigestTime).toBe('00:00');
      expect(result.data.weeklyReviewDay).toBe('sunday');
    });

    it('should validate custom settings', () => {
      const settings = {
        version: 2,
        confidenceThreshold: 0.8,
        dailyDigestTime: '08:30',
        weeklyReviewTime: '17:00',
        weeklyReviewDay: 'friday',
        defaultProvider: 'anthropic',
        defaultModel: 'claude-3'
      };
      const result = brainSettingsSchema.safeParse(settings);
      expect(result.success).toBe(true);
    });

    it('should reject invalid time format', () => {
      const settings = { dailyDigestTime: '9:00' };
      expect(brainSettingsSchema.safeParse(settings).success).toBe(false);
    });

    it('should reject confidenceThreshold outside 0-1', () => {
      expect(brainSettingsSchema.safeParse({ confidenceThreshold: -0.1 }).success).toBe(false);
      expect(brainSettingsSchema.safeParse({ confidenceThreshold: 1.1 }).success).toBe(false);
    });
  });

  describe('captureInputSchema', () => {
    it('should validate capture input', () => {
      const input = { text: 'New thought to capture' };
      const result = captureInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should allow overrides', () => {
      const input = {
        text: 'Capture this',
        providerOverride: 'openai',
        modelOverride: 'gpt-4'
      };
      const result = captureInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should reject empty text', () => {
      expect(captureInputSchema.safeParse({ text: '' }).success).toBe(false);
    });

    it('should reject text over 10000 characters', () => {
      expect(captureInputSchema.safeParse({ text: 'a'.repeat(10001) }).success).toBe(false);
    });
  });

  describe('inboxQuerySchema', () => {
    it('should apply defaults', () => {
      const result = inboxQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    });

    it('should coerce string numbers', () => {
      const result = inboxQuerySchema.safeParse({ limit: '25', offset: '10' });
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(25);
      expect(result.data.offset).toBe(10);
    });

    it('should reject limit over 100', () => {
      expect(inboxQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    });

    it('should reject negative offset', () => {
      expect(inboxQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    });
  });

  describe('linkRecordSchema', () => {
    it('should validate a complete link record', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://github.com/example/repo',
        title: 'Example Repository',
        description: 'A great example repo',
        linkType: 'github',
        tags: ['reference'],
        isGitHubRepo: true,
        gitHubOwner: 'example',
        gitHubRepo: 'repo',
        cloneStatus: 'cloned',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      const result = linkRecordSchema.safeParse(record);
      expect(result.success).toBe(true);
    });

    it('should reject invalid URL', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'not-a-url',
        title: 'Test',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(linkRecordSchema.safeParse(record).success).toBe(false);
    });

    it('should reject invalid cloneStatus', () => {
      const record = {
        id: '550e8400-e29b-41d4-a716-446655440000',
        url: 'https://example.com',
        title: 'Test',
        cloneStatus: 'invalid',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z'
      };
      expect(linkRecordSchema.safeParse(record).success).toBe(false);
    });
  });

  describe('linkInputSchema', () => {
    it('should validate minimal input', () => {
      const input = { url: 'https://example.com' };
      const result = linkInputSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('should apply autoClone default', () => {
      const input = { url: 'https://example.com' };
      const result = linkInputSchema.safeParse(input);
      expect(result.success).toBe(true);
      expect(result.data.autoClone).toBe(true);
    });

    it('should reject invalid URL', () => {
      expect(linkInputSchema.safeParse({ url: 'not-valid' }).success).toBe(false);
    });

    it('should accept a bucketId + bucketOrder', () => {
      const result = linkInputSchema.safeParse({
        url: 'https://example.com',
        bucketId: '11111111-1111-4111-8111-111111111111',
        bucketOrder: 3
      });
      expect(result.success).toBe(true);
      expect(result.data.bucketOrder).toBe(3);
    });

    it('should reject a non-uuid bucketId', () => {
      expect(linkInputSchema.safeParse({ url: 'https://example.com', bucketId: 'nope' }).success).toBe(false);
    });
  });

  describe('linkUpdateInputSchema', () => {
    it('should accept a null bucketId (unassign)', () => {
      const result = linkUpdateInputSchema.safeParse({ bucketId: null });
      expect(result.success).toBe(true);
      expect(result.data.bucketId).toBeNull();
    });

    it('should accept a url-only update', () => {
      const result = linkUpdateInputSchema.safeParse({ url: 'https://example.com/new' });
      expect(result.success).toBe(true);
      expect(result.data.url).toBe('https://example.com/new');
    });

    it('should accept a title-only update (url omitted)', () => {
      const result = linkUpdateInputSchema.safeParse({ title: 'New title' });
      expect(result.success).toBe(true);
      expect(result.data.url).toBeUndefined();
    });

    it('should reject an invalid url', () => {
      expect(linkUpdateInputSchema.safeParse({ url: 'not-valid' }).success).toBe(false);
    });
  });

  describe('linksQuerySchema', () => {
    it('should apply defaults', () => {
      const result = linksQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.limit).toBe(50);
      expect(result.data.offset).toBe(0);
    });

    it('should coerce isGitHubRepo boolean', () => {
      const result = linksQuerySchema.safeParse({ isGitHubRepo: 'true' });
      expect(result.success).toBe(true);
      expect(result.data.isGitHubRepo).toBe(true);
    });

    it('should coerce the string "false" to false (not true)', () => {
      const result = linksQuerySchema.safeParse({ isGitHubRepo: 'false' });
      expect(result.success).toBe(true);
      expect(result.data.isGitHubRepo).toBe(false);
    });

    it('should filter by linkType', () => {
      const result = linksQuerySchema.safeParse({ linkType: 'documentation' });
      expect(result.success).toBe(true);
      expect(result.data.linkType).toBe('documentation');
    });
  });

  describe('bucketInputSchema', () => {
    it('should accept a minimal name-only bucket', () => {
      expect(bucketInputSchema.safeParse({ name: 'Disney' }).success).toBe(true);
    });

    it('should accept a valid color + icon', () => {
      const result = bucketInputSchema.safeParse({ name: 'Disney', color: 'purple', icon: '🎢' });
      expect(result.success).toBe(true);
    });

    it('should reject an empty name', () => {
      expect(bucketInputSchema.safeParse({ name: '' }).success).toBe(false);
    });

    it('should reject an unknown color', () => {
      expect(bucketInputSchema.safeParse({ name: 'X', color: 'neon' }).success).toBe(false);
    });
  });

  describe('bucketUpdateInputSchema', () => {
    it('should accept a partial update', () => {
      const result = bucketUpdateInputSchema.safeParse({ order: 2 });
      expect(result.success).toBe(true);
      expect(result.data.order).toBe(2);
    });
  });

  describe('bucketReorderSchema', () => {
    it('should accept a list of uuids', () => {
      const result = bucketReorderSchema.safeParse({
        ids: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
      });
      expect(result.success).toBe(true);
    });

    it('should reject an empty list', () => {
      expect(bucketReorderSchema.safeParse({ ids: [] }).success).toBe(false);
    });

    it('should reject non-uuid entries', () => {
      expect(bucketReorderSchema.safeParse({ ids: ['nope'] }).success).toBe(false);
    });
  });

  describe('linkReorderSchema', () => {
    const idA = '11111111-1111-4111-8111-111111111111';
    const idB = '22222222-2222-4222-8222-222222222222';
    const bucket = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

    it('should accept a batch of { id, bucketId, bucketOrder }', () => {
      const result = linkReorderSchema.safeParse({
        updates: [
          { id: idA, bucketId: bucket, bucketOrder: 0 },
          { id: idB, bucketId: bucket, bucketOrder: 1 }
        ]
      });
      expect(result.success).toBe(true);
    });

    it('should accept a null bucketId (ungrouped landing)', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: idA, bucketId: null, bucketOrder: 0 }] }).success).toBe(true);
    });

    it('should reject an empty batch', () => {
      expect(linkReorderSchema.safeParse({ updates: [] }).success).toBe(false);
    });

    it('should reject a non-integer bucketOrder', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: idA, bucketId: bucket, bucketOrder: 1.5 }] }).success).toBe(false);
    });

    it('should reject a non-uuid id (parity with the link update schema)', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: 'l1', bucketId: bucket, bucketOrder: 0 }] }).success).toBe(false);
    });

    it('should reject a non-uuid bucketId', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ id: idA, bucketId: 'b1', bucketOrder: 0 }] }).success).toBe(false);
    });

    it('should reject an entry missing its id', () => {
      expect(linkReorderSchema.safeParse({ updates: [{ bucketId: bucket, bucketOrder: 0 }] }).success).toBe(false);
    });
  });

  describe('brainSyncQuerySchema', () => {
    it('should accept valid query with defaults', () => {
      const result = brainSyncQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      expect(result.data.since).toBe(0);
      expect(result.data.limit).toBe(100);
    });

    it('should coerce string since to number', () => {
      const result = brainSyncQuerySchema.safeParse({ since: '5', limit: '50' });
      expect(result.success).toBe(true);
      expect(result.data.since).toBe(5);
      expect(result.data.limit).toBe(50);
    });

    it('should reject negative since', () => {
      const result = brainSyncQuerySchema.safeParse({ since: -1 });
      expect(result.success).toBe(false);
    });

    it('should reject limit exceeding 1000', () => {
      const result = brainSyncQuerySchema.safeParse({ limit: 1001 });
      expect(result.success).toBe(false);
    });

    it('should reject limit of 0', () => {
      const result = brainSyncQuerySchema.safeParse({ limit: 0 });
      expect(result.success).toBe(false);
    });
  });

  describe('brainSyncPushSchema', () => {
    const validChange = {
      seq: 1,
      op: 'create',
      type: 'people',
      id: 'abc-123',
      record: { name: 'Test' },
      originInstanceId: 'inst-1',
      ts: '2026-01-01T00:00:00Z'
    };

    it('should accept valid push with one change', () => {
      const result = brainSyncPushSchema.safeParse({ changes: [validChange] });
      expect(result.success).toBe(true);
    });

    it('should reject empty changes array', () => {
      const result = brainSyncPushSchema.safeParse({ changes: [] });
      expect(result.success).toBe(false);
    });

    it('should reject invalid op values', () => {
      const result = brainSyncPushSchema.safeParse({
        changes: [{ ...validChange, op: 'upsert' }]
      });
      expect(result.success).toBe(false);
    });

    it('should accept delete with null record', () => {
      const result = brainSyncPushSchema.safeParse({
        changes: [{ ...validChange, op: 'delete', record: null }]
      });
      expect(result.success).toBe(true);
    });

    it('should accept change without optional fields', () => {
      const { originInstanceId, record, ...minimal } = validChange;
      const result = brainSyncPushSchema.safeParse({ changes: [minimal] });
      expect(result.success).toBe(true);
    });
  });
});
