import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing the module
vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: vi.fn()
}));

vi.mock('fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(),
  mkdir: vi.fn().mockResolvedValue()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true)
}));

// Import after mocking
const { readJSONFile } = await import('../lib/fileUtils.js');
const { writeFile } = await import('fs/promises');
const {
  getAllTemplates,
  getPopularTemplates,
  recordTemplateUsage,
  createTemplate,
  deleteTemplate
} = await import('./taskTemplates.js');

describe('taskTemplates service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getAllTemplates', () => {
    it('returns built-in templates when no user templates exist', async () => {
      readJSONFile.mockResolvedValue(null);

      const templates = await getAllTemplates();

      expect(templates.length).toBeGreaterThan(0);
      expect(templates.every(t => t.isBuiltin)).toBe(true);
      expect(templates.every(t => t.id.startsWith('builtin-'))).toBe(true);
      expect(templates.every(t => t.useCount === 0)).toBe(true);
    });

    it('merges built-in and user templates', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [
          {
            id: 'user-abc123',
            name: 'My Template',
            description: 'Custom',
            icon: '🔥',
            context: 'some context',
            isBuiltin: false
          }
        ],
        usage: {},
        lastUpdated: '2025-01-01T00:00:00.000Z'
      });

      const templates = await getAllTemplates();

      const builtInCount = templates.filter(t => t.isBuiltin).length;
      const userCount = templates.filter(t => !t.isBuiltin).length;

      expect(builtInCount).toBeGreaterThan(0);
      expect(userCount).toBe(1);
      expect(templates.find(t => t.id === 'user-abc123')).toBeDefined();
    });

    it('includes usage counts from state', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [
          {
            id: 'user-abc123',
            name: 'My Template',
            description: 'Custom',
            icon: '🔥',
            context: 'some context',
            isBuiltin: false
          }
        ],
        usage: {
          'user-abc123': 5,
          'builtin-mobile-fix': 3
        },
        lastUpdated: '2025-01-01T00:00:00.000Z'
      });

      const templates = await getAllTemplates();

      const userTemplate = templates.find(t => t.id === 'user-abc123');
      const builtinTemplate = templates.find(t => t.id === 'builtin-mobile-fix');

      expect(userTemplate.useCount).toBe(5);
      expect(builtinTemplate.useCount).toBe(3);
    });
  });

  describe('createTemplate', () => {
    it('creates with generated ID and correct fields', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [],
        usage: {},
        lastUpdated: null
      });

      const templateData = {
        name: 'Test Template',
        icon: '🚀',
        description: 'Test description',
        context: 'Test context',
        category: 'testing',
        provider: 'openai',
        model: 'gpt-4',
        app: 'test-app'
      };

      const newTemplate = await createTemplate(templateData);

      expect(newTemplate.id).toMatch(/^user-/);
      expect(newTemplate.name).toBe('Test Template');
      expect(newTemplate.icon).toBe('🚀');
      expect(newTemplate.description).toBe('Test description');
      expect(newTemplate.context).toBe('Test context');
      expect(newTemplate.category).toBe('testing');
      expect(newTemplate.provider).toBe('openai');
      expect(newTemplate.model).toBe('gpt-4');
      expect(newTemplate.app).toBe('test-app');
      expect(newTemplate.isBuiltin).toBe(false);
      expect(newTemplate.createdAt).toBeDefined();

      expect(writeFile).toHaveBeenCalled();
    });
  });

  describe('deleteTemplate', () => {
    it('returns error for built-in templates', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [],
        usage: {},
        lastUpdated: null
      });

      const result = await deleteTemplate('builtin-mobile-fix');

      expect(result.error).toBe('Cannot delete built-in templates');
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('deletes user templates', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [
          {
            id: 'user-abc123',
            name: 'My Template',
            description: 'Custom',
            icon: '🔥',
            context: 'some context',
            isBuiltin: false
          }
        ],
        usage: {
          'user-abc123': 5
        },
        lastUpdated: '2025-01-01T00:00:00.000Z'
      });

      const result = await deleteTemplate('user-abc123');

      expect(result.success).toBe(true);
      expect(result.deleted.id).toBe('user-abc123');
      expect(writeFile).toHaveBeenCalled();

      const savedState = JSON.parse(writeFile.mock.calls[0][1]);
      expect(savedState.userTemplates.length).toBe(0);
      expect(savedState.usage['user-abc123']).toBeUndefined();
    });
  });

  describe('recordTemplateUsage', () => {
    it('increments usage counter', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [],
        usage: {
          'builtin-mobile-fix': 3
        },
        lastUpdated: '2025-01-01T00:00:00.000Z'
      });

      const count = await recordTemplateUsage('builtin-mobile-fix');

      expect(count).toBe(4);
      expect(writeFile).toHaveBeenCalled();

      const savedState = JSON.parse(writeFile.mock.calls[0][1]);
      expect(savedState.usage['builtin-mobile-fix']).toBe(4);
    });
  });

  describe('getPopularTemplates', () => {
    it('returns sorted by useCount descending', async () => {
      readJSONFile.mockResolvedValue({
        userTemplates: [
          {
            id: 'user-abc123',
            name: 'My Template',
            description: 'Custom',
            icon: '🔥',
            context: 'some context',
            isBuiltin: false
          }
        ],
        usage: {
          'user-abc123': 10,
          'builtin-mobile-fix': 3,
          'builtin-add-feature': 7
        },
        lastUpdated: '2025-01-01T00:00:00.000Z'
      });

      const popular = await getPopularTemplates(3);

      expect(popular.length).toBe(3);
      expect(popular[0].id).toBe('user-abc123');
      expect(popular[0].useCount).toBe(10);
      expect(popular[1].id).toBe('builtin-add-feature');
      expect(popular[1].useCount).toBe(7);
      expect(popular[2].id).toBe('builtin-mobile-fix');
      expect(popular[2].useCount).toBe(3);
    });
  });
});
