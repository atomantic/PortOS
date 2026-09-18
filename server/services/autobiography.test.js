import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock fs/promises and fs
vi.mock('fs/promises', () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn()
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(() => true)
}));

// Track notification calls
const mockAddNotification = vi.fn();
const mockNotificationExists = vi.fn(() => false);

vi.mock('./notifications.js', () => ({
  addNotification: (...args) => mockAddNotification(...args),
  NOTIFICATION_TYPES: { AUTOBIOGRAPHY_PROMPT: 'autobiography_prompt' },
  PRIORITY_LEVELS: { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' },
  exists: (...args) => mockNotificationExists(...args)
}));

// Mock uuid
let uuidCounter = 0;
vi.mock('../lib/uuid.js', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}));

// Mock providers + AI provider (LLM calls in generateFollowUps / weaveChainNarrative)
const mockGetActiveProvider = vi.fn();
const mockGetProviderById = vi.fn();
vi.mock('./providers.js', () => ({
  getActiveProvider: (...args) => mockGetActiveProvider(...args),
  getProviderById: (...args) => mockGetProviderById(...args)
}));

const mockCallProviderAISimple = vi.fn();
vi.mock('./aiProvider.js', () => ({
  callProviderAISimple: (...args) => mockCallProviderAISimple(...args),
  // Real-ish JSON extractor good enough for tests
  parseLLMJSON: (raw) => JSON.parse(raw)
}));

// Mock fileUtils.js
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const fsPromises = await import('fs/promises');
  const fs = await import('fs');
  return {
    ensureDir: vi.fn(),
    // atomicWrite replaced raw writeFile(JSON.stringify) sites (#1837). Route it
    // through the mocked fs/promises.writeFile so each test's existing
    // writeFile.mockImplementation capture keeps working unchanged.
    atomicWrite: vi.fn(async (filePath, data) => {
      const payload = (typeof data === 'string' || Buffer.isBuffer(data)) ? data : JSON.stringify(data, null, 2);
      return fsPromises.writeFile(filePath, payload);
    }),
    PATHS: { digitalTwin: '/mock/data/digital-twin' },
    readJSONFile: vi.fn(async (filePath, defaultValue) => {
      if (!fs.existsSync(filePath)) return defaultValue;
      const content = await fsPromises.readFile(filePath, 'utf-8');
      if (!content || !content.trim()) return defaultValue;
      return JSON.parse(content);
    })
  };
});

import { readFile, writeFile } from 'fs/promises';
import {
  getThemes,
  getNextPrompt,
  getPromptById,
  saveStory,
  updateStory,
  deleteStory,
  getStories,
  getStats,
  getConfig,
  updateConfig,
  checkAndPrompt,
  depthGuidanceForChain,
  generateFollowUps,
  getStoryChain,
  weaveChainNarrative,
  getPromptSuggestions,
  sendStoryPrompt,
  evaluateStory,
  autobiographyConfigEvents,
  PROMPT_SUGGESTION_COUNT,
  CUSTOM_PROMPT_ID
} from './autobiography.js';

// Helper: build stories data
const makeStoriesData = (overrides = {}) => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  version: 1,
  stories: [],
  usedPrompts: [],
  ...overrides
});

// Helper: build config data
const makeConfigData = (overrides = {}) => ({
  intervalHours: 24,
  enabled: true,
  lastPromptAt: null,
  lastPromptId: null,
  ...overrides
});

// The service reads two files: stories.json and config.json
// We route readFile responses based on call order or path content
const setupMocks = (storiesData, configData) => {
  readFile.mockImplementation(async (filePath) => {
    if (filePath.includes('config.json')) return JSON.stringify(configData);
    return JSON.stringify(storiesData);
  });
};

// Capture what the service writes to stories.json (config writes are routed to
// the same mocked writeFile, so the discriminator lives here rather than in
// each test). `.value` stays null when nothing was written, which is itself
// the assertion in the "must not persist" cases.
const captureSavedStories = () => {
  const box = { value: null };
  writeFile.mockImplementation(async (filePath, content) => {
    if (!filePath.includes('config.json')) box.value = JSON.parse(content);
  });
  return box;
};

const setupPersistentMocks = (storiesData, configData) => {
  let storedStories = JSON.parse(JSON.stringify(storiesData));
  let storedConfig = JSON.parse(JSON.stringify(configData));

  readFile.mockImplementation(async (filePath) => JSON.stringify(
    filePath.includes('config.json') ? storedConfig : storedStories
  ));
  writeFile.mockImplementation(async (filePath, content) => {
    if (filePath.includes('config.json')) {
      storedConfig = JSON.parse(content);
    } else {
      storedStories = JSON.parse(content);
    }
  });

  return {
    getConfig: () => storedConfig,
    getStories: () => storedStories
  };
};

describe('Autobiography - getThemes', () => {
  it('should return all 12 bank themes with prompt counts, plus the custom pseudo-theme', () => {
    const themes = getThemes();

    // 12 bank themes of 5 prompts each, then 'custom' — which has no bank
    // prompts by definition but needs a filter chip for the stories written
    // against a question the user typed themselves.
    expect(themes).toHaveLength(13);
    expect(themes[0]).toHaveProperty('id');
    expect(themes[0]).toHaveProperty('label');
    expect(themes[0]).toHaveProperty('promptCount');
    expect(themes.slice(0, 12).every(t => t.promptCount === 5)).toBe(true);
    expect(themes[12]).toEqual({ id: 'custom', label: 'Your Own Question', promptCount: 0 });
  });

  it('should include expected theme IDs', () => {
    const themes = getThemes();
    const ids = themes.map(t => t.id);

    expect(ids).toContain('childhood');
    expect(ids).toContain('family');
    expect(ids).toContain('career');
    expect(ids).toContain('turning_point');
  });
});

describe('Autobiography - getNextPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return a prompt with expected fields', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const prompt = await getNextPrompt();

    expect(prompt).toHaveProperty('id');
    expect(prompt).toHaveProperty('themeId');
    expect(prompt).toHaveProperty('themeLabel');
    expect(prompt).toHaveProperty('text');
  });

  it('should prefer prompts from least-used themes', async () => {
    const data = makeStoriesData({
      stories: [
        { themeId: 'childhood', wordCount: 100 },
        { themeId: 'childhood', wordCount: 200 },
        { themeId: 'childhood', wordCount: 150 }
      ]
    });
    setupMocks(data, makeConfigData());

    const prompt = await getNextPrompt();

    // Should not pick childhood since it has the most stories
    expect(prompt.themeId).not.toBe('childhood');
  });

  it('should skip used prompts', async () => {
    const data = makeStoriesData({
      usedPrompts: ['childhood-0']
    });
    setupMocks(data, makeConfigData());

    const prompt = await getNextPrompt();

    expect(prompt.id).not.toBe('childhood-0');
  });

  it('should reset used prompts when all are used', async () => {
    // Build a usedPrompts list with all 60 prompts (12 themes x 5 prompts)
    const themes = getThemes();
    const allIds = themes.flatMap(t =>
      Array.from({ length: t.promptCount }, (_, i) => `${t.id}-${i}`)
    );

    let savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });

    const data = makeStoriesData({ usedPrompts: allIds });
    setupMocks(data, makeConfigData());

    const prompt = await getNextPrompt();

    // A real prompt object, not just any truthy value.
    expect(prompt).toMatchObject({
      id: expect.any(String),
      themeId: expect.any(String),
      text: expect.any(String),
    });
    expect(prompt.text.length).toBeGreaterThan(0);
    // usedPrompts should have been reset
    expect(savedData.usedPrompts).toEqual([]);
  });

  it('should exclude the specified prompt ID when skipping', async () => {
    // Use a fresh data set where childhood-0 would normally be first
    setupMocks(makeStoriesData(), makeConfigData());

    const firstPrompt = await getNextPrompt();
    const skippedPrompt = await getNextPrompt(firstPrompt.id);

    expect(skippedPrompt.id).not.toBe(firstPrompt.id);
  });

  it('should fall back to excluded prompt if it is the only one left', async () => {
    // Mark all prompts as used except one
    const themes = getThemes();
    const allIds = themes.flatMap(t =>
      Array.from({ length: t.promptCount }, (_, i) => `${t.id}-${i}`)
    );
    const remaining = allIds[0]; // Only this one is unused
    const usedExceptOne = allIds.filter(id => id !== remaining);

    writeFile.mockImplementation(async () => {});
    const data = makeStoriesData({ usedPrompts: usedExceptOne });
    setupMocks(data, makeConfigData());

    // Exclude the only remaining prompt; should still return it as fallback
    const prompt = await getNextPrompt(remaining);

    expect(prompt.id).toBe(remaining);
  });
});

describe('Autobiography - getPromptById', () => {
  it('should return the correct prompt for a valid ID', () => {
    const prompt = getPromptById('childhood-0');

    expect(prompt).not.toBeNull();
    expect(prompt.id).toBe('childhood-0');
    expect(prompt.themeId).toBe('childhood');
    expect(prompt.themeLabel).toBe('Childhood');
    expect(typeof prompt.text).toBe('string');
    expect(prompt.text.length).toBeGreaterThan(0);
  });

  it('should return null for an invalid ID', () => {
    const prompt = getPromptById('nonexistent-99');

    expect(prompt).toBeNull();
  });

  it('should return the right prompt text for a specific index', () => {
    const prompt = getPromptById('family-2');

    expect(prompt.themeId).toBe('family');
    expect(prompt.text).toContain('family tells about you');
  });
});

describe('Autobiography - saveStory', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });
  });

  it('should save a story with correct fields', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const story = await saveStory({ promptId: 'childhood-0', content: 'My first memory is the old red house.' });

    expect(story.id).toBe('test-uuid-1');
    expect(story.promptId).toBe('childhood-0');
    expect(story.themeId).toBe('childhood');
    expect(story.themeLabel).toBe('Childhood');
    expect(story.content).toBe('My first memory is the old red house.');
    expect(story.wordCount).toBe(8);
    // createdAt must be a round-trippable ISO-8601 timestamp, not just truthy.
    expect(new Date(story.createdAt).toISOString()).toBe(story.createdAt);
  });

  it('should add the prompt to usedPrompts', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    await saveStory({ promptId: 'childhood-0', content: 'A story about childhood.' });

    expect(savedData.usedPrompts).toContain('childhood-0');
  });

  it('should not duplicate prompt in usedPrompts', async () => {
    const data = makeStoriesData({ usedPrompts: ['childhood-0'] });
    setupMocks(data, makeConfigData());

    await saveStory({ promptId: 'childhood-0', content: 'Another childhood story.' });

    const count = savedData.usedPrompts.filter(id => id === 'childhood-0').length;
    expect(count).toBe(1);
  });

  it('should handle unknown prompt gracefully', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const story = await saveStory({ promptId: 'nonexistent-99', content: 'Some content' });

    expect(story.themeId).toBe('unknown');
    expect(story.themeLabel).toBe('Unknown');
    expect(story.promptText).toBe('');
  });

  it('should calculate word count correctly', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const story = await saveStory({
      promptId: 'childhood-0',
      content: '  Hello   world   this  is  a   test  '
    });

    expect(story.wordCount).toBe(6);
  });
});

describe('Autobiography - updateStory', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });
  });

  it('should update content and word count', async () => {
    const data = makeStoriesData({
      stories: [{
        id: 'story-1',
        promptId: 'childhood-0',
        themeId: 'childhood',
        themeLabel: 'Childhood',
        content: 'Original content',
        wordCount: 2,
        createdAt: '2026-01-01T00:00:00.000Z'
      }]
    });
    setupMocks(data, makeConfigData());

    const updated = await updateStory('story-1', 'Updated content with more words');

    expect(updated.content).toBe('Updated content with more words');
    expect(updated.wordCount).toBe(5);
    // updatedAt is a valid ISO timestamp and strictly newer than the
    // original createdAt (2026-01-01), not merely truthy.
    expect(new Date(updated.updatedAt).toISOString()).toBe(updated.updatedAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(
      new Date('2026-01-01T00:00:00.000Z').getTime(),
    );
  });

  it('should return null for non-existent story', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const result = await updateStory('nonexistent', 'New content');

    expect(result).toBeNull();
  });
});

describe('Autobiography - deleteStory', () => {
  let savedData;

  beforeEach(() => {
    vi.clearAllMocks();
    savedData = null;
    writeFile.mockImplementation(async (_path, content) => {
      savedData = JSON.parse(content);
    });
  });

  it('should remove the story from data', async () => {
    const data = makeStoriesData({
      stories: [
        { id: 'story-1', themeId: 'childhood', themeLabel: 'Childhood', content: 'First' },
        { id: 'story-2', themeId: 'family', themeLabel: 'Family', content: 'Second' }
      ]
    });
    setupMocks(data, makeConfigData());

    const removed = await deleteStory('story-1');

    expect(removed.id).toBe('story-1');
    expect(savedData.stories).toHaveLength(1);
    expect(savedData.stories[0].id).toBe('story-2');
  });

  it('should return null for non-existent story', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const result = await deleteStory('nonexistent');

    expect(result).toBeNull();
  });
});

describe('Autobiography - concurrent mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    uuidCounter = 0;
  });

  it('preserves stories and tombstones across concurrent story operations', async () => {
    const allPromptIds = getThemes().flatMap(theme =>
      Array.from({ length: theme.promptCount }, (_, i) => `${theme.id}-${i}`)
    );
    const persisted = setupPersistentMocks(makeStoriesData({
      stories: [
        { id: 'delete-me', themeId: 'family', themeLabel: 'Family', content: 'Old story' }
      ],
      usedPrompts: allPromptIds,
      deletedStories: [{ id: 'previous-delete', deletedAt: '2026-01-01T00:00:00.000Z' }]
    }), makeConfigData());

    await Promise.all([
      saveStory({ promptId: 'childhood-0', content: 'A newly preserved story.' }),
      deleteStory('delete-me'),
      getNextPrompt()
    ]);

    const stored = persisted.getStories();
    expect(stored.stories.map(story => story.id)).toEqual(['test-uuid-1']);
    expect(stored.deletedStories.map(tombstone => tombstone.id)).toEqual(
      expect.arrayContaining(['delete-me', 'previous-delete'])
    );
    expect(stored.usedPrompts).toEqual([]);
  });

  it('merges concurrent config updates against the latest write', async () => {
    const persisted = setupPersistentMocks(makeStoriesData(), makeConfigData());

    await Promise.all([
      updateConfig({ intervalHours: 48 }),
      updateConfig({ enabled: false })
    ]);

    expect(persisted.getConfig()).toMatchObject({
      intervalHours: 48,
      enabled: false
    });
  });
});

describe('Autobiography - getStories', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return all stories sorted newest first', async () => {
    const data = makeStoriesData({
      stories: [
        { id: 's1', themeId: 'childhood', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 's2', themeId: 'family', createdAt: '2026-01-03T00:00:00.000Z' },
        { id: 's3', themeId: 'childhood', createdAt: '2026-01-02T00:00:00.000Z' }
      ]
    });
    setupMocks(data, makeConfigData());

    const stories = await getStories();

    expect(stories).toHaveLength(3);
    expect(stories[0].id).toBe('s2');
    expect(stories[1].id).toBe('s3');
    expect(stories[2].id).toBe('s1');
  });

  it('should filter by theme when specified', async () => {
    const data = makeStoriesData({
      stories: [
        { id: 's1', themeId: 'childhood', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 's2', themeId: 'family', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 's3', themeId: 'childhood', createdAt: '2026-01-03T00:00:00.000Z' }
      ]
    });
    setupMocks(data, makeConfigData());

    const stories = await getStories('childhood');

    expect(stories).toHaveLength(2);
    expect(stories.every(s => s.themeId === 'childhood')).toBe(true);
  });

  it('should return empty array when no stories exist', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const stories = await getStories();

    expect(stories).toEqual([]);
  });
});

describe('Autobiography - getStats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return correct stats for existing stories', async () => {
    const data = makeStoriesData({
      stories: [
        { themeId: 'childhood', wordCount: 100 },
        { themeId: 'childhood', wordCount: 200 },
        { themeId: 'family', wordCount: 150 }
      ],
      usedPrompts: ['childhood-0', 'childhood-1', 'family-0']
    });
    const config = makeConfigData({ lastPromptAt: '2026-01-01T00:00:00.000Z' });
    setupMocks(data, config);

    const stats = await getStats();

    expect(stats.totalStories).toBe(3);
    expect(stats.totalWords).toBe(450);
    expect(stats.byTheme.childhood).toBe(2);
    expect(stats.byTheme.family).toBe(1);
    expect(stats.usedPrompts).toBe(3);
    expect(stats.totalPrompts).toBe(60); // 12 themes x 5 prompts
    expect(stats.promptsRemaining).toBe(57);
    expect(stats.config.enabled).toBe(true);
    expect(stats.config.intervalHours).toBe(24);
    expect(stats.config.lastPromptAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('should return zeroes for empty data', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const stats = await getStats();

    expect(stats.totalStories).toBe(0);
    expect(stats.totalWords).toBe(0);
    expect(stats.usedPrompts).toBe(0);
    expect(stats.promptsRemaining).toBe(60);
  });
});

describe('Autobiography - config', () => {
  let savedConfig;

  beforeEach(() => {
    vi.clearAllMocks();
    savedConfig = null;
    writeFile.mockImplementation(async (filePath, content) => {
      if (filePath.includes('config.json')) {
        savedConfig = JSON.parse(content);
      }
    });
  });

  it('should return default config when none exists', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const config = await getConfig();

    expect(config.enabled).toBe(true);
    expect(config.intervalHours).toBe(24);
    expect(config.lastPromptAt).toBeNull();
  });

  it('should merge updates into existing config', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const updated = await updateConfig({ intervalHours: 48 });

    expect(updated.intervalHours).toBe(48);
    expect(updated.enabled).toBe(true); // preserved from default
    expect(savedConfig.intervalHours).toBe(48);
  });

  it('should allow disabling prompts', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const updated = await updateConfig({ enabled: false });

    expect(updated.enabled).toBe(false);
  });
});

describe('Autobiography - checkAndPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddNotification.mockResolvedValue({});
    mockNotificationExists.mockResolvedValue(false);
    writeFile.mockImplementation(async () => {});
  });

  it('should return disabled when config.enabled is false', async () => {
    setupMocks(makeStoriesData(), makeConfigData({ enabled: false }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(false);
    expect(result.reason).toBe('disabled');
    expect(mockAddNotification).not.toHaveBeenCalled();
  });

  it('should return not_due when interval has not elapsed', async () => {
    const recentTime = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    setupMocks(makeStoriesData(), makeConfigData({ lastPromptAt: recentTime }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(false);
    expect(result.reason).toBe('not_due');
  });

  // Regression: the cadence guard is the interval since `lastPromptAt`, NOT
  // "does a notification of this type already exist". `notifications.exists`
  // matches ANY notification of the type ever created, read or not — gating on
  // it silenced the daily prompt permanently after its very first nudge.
  it('prompts again on the next interval even though earlier prompts are still in the tray', async () => {
    mockNotificationExists.mockResolvedValue(true);
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
    setupMocks(makeStoriesData(), makeConfigData({ lastPromptAt: oldTime }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(true);
    expect(mockAddNotification).toHaveBeenCalledTimes(1);
  });

  it('should create notification when prompt is due', async () => {
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setupMocks(makeStoriesData(), makeConfigData({ lastPromptAt: oldTime }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(true);
    expect(result.prompt).toHaveProperty('id');
    expect(result.prompt).toHaveProperty('themeId');
    expect(mockAddNotification).toHaveBeenCalledTimes(1);

    const notification = mockAddNotification.mock.calls[0][0];
    expect(notification.type).toBe('autobiography_prompt');
    expect(notification.title).toBe('5-Minute Story Time');
    expect(notification.priority).toBe('low');
    expect(notification.link).toContain('/digital-twin/autobiography?prompt=');
    expect(notification.metadata).toHaveProperty('promptId');
    expect(notification.metadata).toHaveProperty('themeId');
    // Verify no redundant type in metadata
    expect(notification.metadata).not.toHaveProperty('type');
  });

  it('creates only one notification across concurrent due checks', async () => {
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setupPersistentMocks(makeStoriesData(), makeConfigData({ lastPromptAt: oldTime }));

    const results = await Promise.all([checkAndPrompt(), checkAndPrompt()]);

    expect(results.filter(result => result.prompted)).toHaveLength(1);
    expect(results.filter(result => result.reason === 'not_due')).toHaveLength(1);
    expect(mockAddNotification).toHaveBeenCalledTimes(1);
  });

  it('should prompt when lastPromptAt is null (first time)', async () => {
    setupMocks(makeStoriesData(), makeConfigData({ lastPromptAt: null }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(true);
    expect(mockAddNotification).toHaveBeenCalledTimes(1);
  });

  it('should update config with lastPromptAt after sending notification', async () => {
    let savedConfig = null;
    writeFile.mockImplementation(async (filePath, content) => {
      if (filePath.includes('config.json')) {
        savedConfig = JSON.parse(content);
      }
    });

    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    setupMocks(makeStoriesData(), makeConfigData({ lastPromptAt: oldTime }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(true);
    expect(savedConfig).not.toBeNull();
    // lastPromptAt is a valid ISO timestamp, freshly stamped — strictly newer
    // than the 48h-old value we seeded — not merely truthy.
    expect(new Date(savedConfig.lastPromptAt).toISOString()).toBe(savedConfig.lastPromptAt);
    expect(new Date(savedConfig.lastPromptAt).getTime()).toBeGreaterThan(new Date(oldTime).getTime());
    expect(savedConfig.lastPromptId).toBe(result.prompt.id);
  });

  it('should respect custom intervalHours', async () => {
    // 6 hours ago, interval is 12h => not due yet
    const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    setupMocks(makeStoriesData(), makeConfigData({
      intervalHours: 12,
      lastPromptAt: sixHoursAgo
    }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(false);
    expect(result.reason).toBe('not_due');
  });
});

// =============================================================================
// FOLLOW-UP CHAINS — depth-aware questions, chain walking, narrative weaving
// =============================================================================

describe('Autobiography - depthGuidanceForChain', () => {
  it('keeps shallow chains close to the scene', () => {
    expect(depthGuidanceForChain(1)).toMatch(/concrete|sensory|scene/i);
  });

  it('shifts to emotion at depth 2', () => {
    expect(depthGuidanceForChain(2)).toMatch(/emotion|motivation|relationship/i);
  });

  it('shifts to cause-and-effect at depth 3', () => {
    expect(depthGuidanceForChain(3)).toMatch(/shaped|choices|became/i);
  });

  it('invites reflection and meaning at deep chains', () => {
    const deep = depthGuidanceForChain(5);
    expect(deep).toMatch(/reflection|meaning|larger arc|looking back/i);
    // Progression must differ from the shallow guidance
    expect(deep).not.toBe(depthGuidanceForChain(1));
  });
});

describe('Autobiography - generateFollowUps (depth-aware)', () => {
  const provider = { id: 'p1', name: 'Test', type: 'api', defaultModel: 'm1' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveProvider.mockResolvedValue(provider);
    mockCallProviderAISimple.mockResolvedValue({ text: '["Q1?","Q2?","Q3?"]' });
    writeFile.mockImplementation(async () => {});
  });

  it('returns an error when the story is missing', async () => {
    setupMocks(makeStoriesData(), makeConfigData());
    const result = await generateFollowUps('nope');
    expect(result.error).toBe('Story not found');
  });

  it('returns an error when no provider is available', async () => {
    mockGetActiveProvider.mockResolvedValue(null);
    setupMocks(makeStoriesData({ stories: [{ id: 's1', content: 'x', promptText: 'p', themeLabel: 'Childhood' }] }), makeConfigData());
    const result = await generateFollowUps('s1');
    expect(result.error).toBe('No AI provider available');
  });

  it('generates and stores exactly 3 follow-ups for a root story', async () => {
    let saved = null;
    writeFile.mockImplementation(async (_p, content) => { saved = JSON.parse(content); });
    setupMocks(makeStoriesData({ stories: [{ id: 's1', content: 'A vivid childhood memory.', promptText: 'Describe it', themeLabel: 'Childhood' }] }), makeConfigData());

    const result = await generateFollowUps('s1');

    expect(result.followUps).toHaveLength(3);
    expect(saved.stories[0].followUpPrompts).toEqual(['Q1?', 'Q2?', 'Q3?']);
    // followUpsGeneratedAt is a round-trippable ISO timestamp, not just truthy.
    const generatedAt = saved.stories[0].followUpsGeneratedAt;
    expect(new Date(generatedAt).toISOString()).toBe(generatedAt);
  });

  it('passes shallow (depth-1) guidance for a root story', async () => {
    setupMocks(makeStoriesData({ stories: [{ id: 's1', content: 'x', promptText: 'p', themeLabel: 'Childhood' }] }), makeConfigData());

    await generateFollowUps('s1');

    const promptArg = mockCallProviderAISimple.mock.calls[0][2];
    expect(promptArg).toContain('This is depth 1 in the story chain.');
    expect(promptArg).toContain(depthGuidanceForChain(1));
  });

  it('passes deeper guidance as the chain grows', async () => {
    // s1 (root) -> s2 -> s3 ; generating for s3 is depth 3
    const stories = [
      { id: 's1', content: 'root', promptText: 'p1', themeLabel: 'Childhood' },
      { id: 's2', content: 'mid', promptText: 'p2', themeLabel: 'Childhood', parentStoryId: 's1' },
      { id: 's3', content: 'leaf', promptText: 'p3', themeLabel: 'Childhood', parentStoryId: 's2' }
    ];
    setupMocks(makeStoriesData({ stories }), makeConfigData());

    await generateFollowUps('s3');

    const promptArg = mockCallProviderAISimple.mock.calls[0][2];
    expect(promptArg).toContain('This is depth 3 in the story chain.');
    expect(promptArg).toContain(depthGuidanceForChain(3));
    // Earlier responses must be present so questions can build on prior answers
    expect(promptArg).toContain('root');
    expect(promptArg).toContain('mid');
  });

  it('returns an error when the AI response is unparseable', async () => {
    mockCallProviderAISimple.mockResolvedValue({ text: 'not json' });
    setupMocks(makeStoriesData({ stories: [{ id: 's1', content: 'x', promptText: 'p', themeLabel: 'Childhood' }] }), makeConfigData());

    const result = await generateFollowUps('s1');
    expect(result.error).toMatch(/Failed to parse/);
  });
});

describe('Autobiography - getStoryChain', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty array when story is missing', async () => {
    setupMocks(makeStoriesData(), makeConfigData());
    expect(await getStoryChain('nope')).toEqual([]);
  });

  it('returns ancestors, the story, and descendants in order', async () => {
    const stories = [
      { id: 's1', content: 'root', promptText: 'p1', themeLabel: 'Childhood', createdAt: '2026-01-01' },
      { id: 's2', content: 'mid', promptText: 'p2', themeLabel: 'Childhood', parentStoryId: 's1', createdAt: '2026-01-02' },
      { id: 's3', content: 'leaf', promptText: 'p3', themeLabel: 'Childhood', parentStoryId: 's2', createdAt: '2026-01-03' }
    ];
    setupMocks(makeStoriesData({ stories }), makeConfigData());

    const chain = await getStoryChain('s2');
    expect(chain.map(s => s.id)).toEqual(['s1', 's2', 's3']);
  });
});

describe('Autobiography - weaveChainNarrative', () => {
  const provider = { id: 'p1', name: 'Test', type: 'api', defaultModel: 'm1' };

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetActiveProvider.mockResolvedValue(provider);
    mockCallProviderAISimple.mockResolvedValue({ text: '  A flowing memoir passage.  ' });
  });

  it('returns an error when the story is missing', async () => {
    setupMocks(makeStoriesData(), makeConfigData());
    const result = await weaveChainNarrative('nope');
    expect(result.error).toBe('Story not found');
  });

  it('returns an error when no provider is available', async () => {
    mockGetActiveProvider.mockResolvedValue(null);
    setupMocks(makeStoriesData({ stories: [{ id: 's1', content: 'x', promptText: 'p', themeLabel: 'Childhood' }] }), makeConfigData());
    const result = await weaveChainNarrative('s1');
    expect(result.error).toBe('No AI provider available');
  });

  it('weaves the full chain into a trimmed narrative and reports the story count', async () => {
    const stories = [
      { id: 's1', content: 'root memory', promptText: 'p1', themeLabel: 'Childhood', createdAt: '2026-01-01' },
      { id: 's2', content: 'deeper memory', promptText: 'p2', themeLabel: 'Childhood', parentStoryId: 's1', createdAt: '2026-01-02' }
    ];
    setupMocks(makeStoriesData({ stories }), makeConfigData());

    const result = await weaveChainNarrative('s1');

    expect(result.narrative).toBe('A flowing memoir passage.');
    expect(result.storyCount).toBe(2);
    // Both responses must be fed to the weaver
    const promptArg = mockCallProviderAISimple.mock.calls[0][2];
    expect(promptArg).toContain('root memory');
    expect(promptArg).toContain('deeper memory');
  });

  it('returns an error when the AI returns an empty narrative', async () => {
    mockCallProviderAISimple.mockResolvedValue({ text: '   ' });
    setupMocks(makeStoriesData({ stories: [{ id: 's1', content: 'x', promptText: 'p', themeLabel: 'Childhood' }] }), makeConfigData());

    const result = await weaveChainNarrative('s1');
    expect(result.error).toMatch(/empty narrative/);
  });
});

// =============================================================================
// STORY IDEAS, OWN QUESTIONS, THE DAILY PROMPT, AND CRAFT EVALUATION
// =============================================================================

describe('Autobiography - getPromptSuggestions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFile.mockImplementation(async () => {});
  });

  it('offers a menu of ideas drawn from DISTINCT themes', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const suggestions = await getPromptSuggestions();

    expect(suggestions).toHaveLength(PROMPT_SUGGESTION_COUNT);
    const themeIds = suggestions.map(p => p.themeId);
    expect(new Set(themeIds).size).toBe(themeIds.length);
  });

  it('never re-offers a prompt already written against', async () => {
    const allButThree = getThemes()
      .filter(t => t.promptCount > 0)
      .flatMap(t => Array.from({ length: t.promptCount }, (_, i) => `${t.id}-${i}`))
      .slice(0, -3);
    setupMocks(makeStoriesData({ usedPrompts: allButThree }), makeConfigData());

    const suggestions = await getPromptSuggestions();

    expect(suggestions).toHaveLength(3);
    for (const prompt of suggestions) {
      expect(allButThree).not.toContain(prompt.id);
    }
  });
});

describe('Autobiography - stories answering your own question', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFile.mockImplementation(async () => {});
  });

  it('files a custom-question story under the custom theme with the question as its promptText', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const story = await saveStory({
      promptId: CUSTOM_PROMPT_ID,
      content: 'It started at my grandmother’s kitchen table.',
      customPromptText: 'Why do I like black licorice?'
    });

    expect(story.themeId).toBe('custom');
    expect(story.themeLabel).toBe('Your Own Question');
    expect(story.promptText).toBe('Why do I like black licorice?');
  });

  it('does not burn a bank slot on the custom sentinel', async () => {
    const savedStories = captureSavedStories();
    setupMocks(makeStoriesData(), makeConfigData());

    await saveStory({
      promptId: CUSTOM_PROMPT_ID,
      content: 'A story.',
      customPromptText: 'Why do I like black licorice?'
    });

    // 'custom' in usedPrompts would occupy a slot no bank prompt can match,
    // delaying the bank's cycle reset forever.
    expect(savedStories.value.usedPrompts).not.toContain(CUSTOM_PROMPT_ID);
  });
});

describe('Autobiography - sendStoryPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAddNotification.mockResolvedValue({});
    mockNotificationExists.mockResolvedValue(false);
    writeFile.mockImplementation(async () => {});
  });

  it('carries the whole menu of ideas, not just the one it leads with', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const result = await sendStoryPrompt();

    expect(result.prompted).toBe(true);
    expect(result.suggestions).toHaveLength(PROMPT_SUGGESTION_COUNT);
    const notification = mockAddNotification.mock.calls[0][0];
    expect(notification.metadata.suggestions).toHaveLength(PROMPT_SUGGESTION_COUNT);
    // The alternates are visible in the description too — a notification the
    // user reads without opening the app should still offer the choice.
    expect(notification.description).toContain(result.suggestions[1].text);
  });

  // sendStoryPrompt has no cadence guard of its own by design — each caller
  // owns one appropriate to it (the job's interval, the cron's local-day
  // check). Pinned because the removed `exists(type)` guard was permanent, not
  // per-day, and reinstating it here would silence the reminder for good.
  it('sends regardless of how many earlier prompts are still in the tray', async () => {
    mockNotificationExists.mockResolvedValue(true);
    setupMocks(makeStoriesData(), makeConfigData());

    const result = await sendStoryPrompt();

    expect(result.prompted).toBe(true);
    expect(mockAddNotification).toHaveBeenCalledTimes(1);
  });
});

describe('Autobiography - config reminder slice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    writeFile.mockImplementation(async () => {});
  });

  it('defaults the reminder to off at 09:00 on a config saved before it existed', async () => {
    setupMocks(makeStoriesData(), makeConfigData());

    const config = await getConfig();

    expect(config.reminder).toEqual({ enabled: false, time: '09:00' });
  });

  it('keeps the saved time when a patch only flips enabled, and stamps updatedAt', async () => {
    setupMocks(makeStoriesData(), makeConfigData({ reminder: { enabled: false, time: '07:30' } }));

    const config = await updateConfig({ reminder: { enabled: true } });

    expect(config.reminder.time).toBe('07:30');
    expect(config.reminder.enabled).toBe(true);
    // The scheduler's catch-up refuses to replay a slot older than this.
    expect(new Date(config.reminder.updatedAt).toISOString()).toBe(config.reminder.updatedAt);
  });

  it('announces the save so the scheduler can re-register without a route hook', async () => {
    setupMocks(makeStoriesData(), makeConfigData());
    const seen = [];
    const listener = (payload) => seen.push(payload);
    autobiographyConfigEvents.on('autobiography-config:updated', listener);

    await updateConfig({ reminder: { time: '06:15' } });
    autobiographyConfigEvents.off('autobiography-config:updated', listener);

    expect(seen).toHaveLength(1);
    expect(seen[0].updates.reminder).toEqual({ time: '06:15' });
    expect(seen[0].config.reminder.time).toBe('06:15');
  });
});

describe('Autobiography - evaluateStory', () => {
  const storyFixture = makeStoriesData({
    stories: [{
      id: 's1',
      promptId: 'custom',
      themeId: 'custom',
      themeLabel: 'Your Own Question',
      promptText: 'Why do I like black licorice?',
      content: 'It started at my grandmother’s kitchen table.',
      wordCount: 7,
      createdAt: '2026-09-01T00:00:00.000Z'
    }]
  });

  const wellFormedAnswer = JSON.stringify({
    moves: {
      curiosity: { score: 4, evidence: 'opens on a question', suggestion: 'hold the answer one beat longer' },
      tension: { score: 3, evidence: '', suggestion: 'raise the stakes' },
      specificity: { score: 5, evidence: 'the kitchen table', suggestion: 'keep it' },
      pace: { score: 3, evidence: '', suggestion: 'slow the tasting' },
      unexpected: { score: 2, evidence: '', suggestion: 'add a turn' },
      personal: { score: 4, evidence: 'grandmother', suggestion: 'name the room' },
      takeaway: { score: 1, evidence: '', suggestion: 'say what it meant' }
    },
    cart: {
      context: { present: true, note: 'kitchen table' },
      action: { present: true, note: 'the first taste' },
      result: { present: true, note: '' },
      takeaway: { present: false, note: 'missing' }
    },
    answersQuestion: true,
    revision: 'End on what the taste stands in for.'
  });

  beforeEach(() => {
    vi.clearAllMocks();
    writeFile.mockImplementation(async () => {});
    mockGetActiveProvider.mockResolvedValue({ id: 'p1', defaultModel: 'm1' });
    mockCallProviderAISimple.mockResolvedValue({ text: wellFormedAnswer });
  });

  it('scores the story and persists the evaluation on it', async () => {
    const savedStories = captureSavedStories();
    setupMocks(storyFixture, makeConfigData());

    const result = await evaluateStory('s1');

    expect(result.evaluation.overallScore).toBe(3.1); // 22/7 = 3.14…
    expect(result.evaluation.moves).toHaveLength(7);
    expect(result.evaluation.weakestMoveId).toBe('takeaway');
    expect(savedStories.value.stories[0].evaluation.overallScore).toBe(3.1);
  });

  it('sends the story and its question to the provider', async () => {
    setupMocks(storyFixture, makeConfigData());

    await evaluateStory('s1');

    const prompt = mockCallProviderAISimple.mock.calls[0][2];
    expect(prompt).toContain('Why do I like black licorice?');
    expect(prompt).toContain('It started at my grandmother’s kitchen table.');
  });

  it('reports an unparseable answer instead of persisting an all-zero score', async () => {
    const savedStories = captureSavedStories();
    setupMocks(storyFixture, makeConfigData());
    mockCallProviderAISimple.mockResolvedValue({ text: 'Sure! Here is my feedback…' });

    const result = await evaluateStory('s1');

    expect(result.error).toMatch(/parse/i);
    expect(savedStories.value).toBeNull();
  });

  it('errors for an unknown story and when no provider is configured', async () => {
    setupMocks(storyFixture, makeConfigData());

    expect((await evaluateStory('nope')).error).toMatch(/not found/i);

    mockGetActiveProvider.mockResolvedValue(null);
    expect((await evaluateStory('s1')).error).toMatch(/provider/i);
  });
});
