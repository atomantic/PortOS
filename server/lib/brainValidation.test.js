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
  linksQuerySchema
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
      expect(result.data.dailyDigestTime).toBe('09:00');
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

    it('should filter by linkType', () => {
      const result = linksQuerySchema.safeParse({ linkType: 'documentation' });
      expect(result.success).toBe(true);
      expect(result.data.linkType).toBe('documentation');
    });
  });
});
