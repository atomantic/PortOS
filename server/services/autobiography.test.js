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
  exists: (...args) => mockNotificationExists(...args)
}));

// Mock uuid
let uuidCounter = 0;
vi.mock('../lib/uuid.js', () => ({
  v4: () => `test-uuid-${++uuidCounter}`
}));

// Mock fileUtils.js
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const fsPromises = await import('fs/promises');
  const fs = await import('fs');
  return {
    ensureDir: vi.fn(),
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
  checkAndPrompt
} from './autobiography.js';

// Helper: build stories data
const makeStoriesData = (overrides = {}) => ({
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

describe('Autobiography - getThemes', () => {
  it('should return all 12 themes with prompt counts', () => {
    const themes = getThemes();

    expect(themes).toHaveLength(12);
    expect(themes[0]).toHaveProperty('id');
    expect(themes[0]).toHaveProperty('label');
    expect(themes[0]).toHaveProperty('promptCount');
    expect(themes.every(t => t.promptCount === 5)).toBe(true);
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

    expect(prompt).toBeTruthy();
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
    expect(prompt.text).toBeTruthy();
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
    expect(story.createdAt).toBeTruthy();
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
    expect(updated.updatedAt).toBeTruthy();
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

  it('should return pending_notification when one already exists', async () => {
    mockNotificationExists.mockResolvedValue(true);
    const oldTime = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(); // 48 hours ago
    setupMocks(makeStoriesData(), makeConfigData({ lastPromptAt: oldTime }));

    const result = await checkAndPrompt();

    expect(result.prompted).toBe(false);
    expect(result.reason).toBe('pending_notification');
    expect(mockNotificationExists).toHaveBeenCalledWith('autobiography_prompt');
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
    expect(savedConfig.lastPromptAt).toBeTruthy();
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
