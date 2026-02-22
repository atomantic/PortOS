/**
 * Autobiography Service
 *
 * Prompts the user on a regular basis to write 5-minute life stories
 * based on thematic prompts, building an autobiography over time.
 *
 * Stories are stored as part of the digital twin data.
 */

import { writeFile } from 'fs/promises';
import { join } from 'path';
import { v4 as uuidv4 } from 'uuid';
import { ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { addNotification, NOTIFICATION_TYPES, exists as notificationExists } from './notifications.js';

const DATA_DIR = join(PATHS.digitalTwin, 'autobiography');
const STORIES_FILE = join(DATA_DIR, 'stories.json');
const CONFIG_FILE = join(DATA_DIR, 'config.json');

// Thematic prompt bank organized by life themes
const PROMPT_THEMES = [
  {
    id: 'childhood',
    label: 'Childhood',
    prompts: [
      'Describe the house or neighborhood you grew up in. What sounds, smells, or textures come back to you?',
      'What was your favorite game or activity as a child? Who did you play with?',
      'Tell the story of a childhood birthday or holiday that stands out in your memory.',
      'What was a rule your parents had that you didn\'t understand until later?',
      'Describe a moment when you felt truly free as a kid.'
    ]
  },
  {
    id: 'family',
    label: 'Family',
    prompts: [
      'Tell the story of a family tradition that shaped who you are.',
      'Describe a conversation with a parent or grandparent that you still think about.',
      'What\'s a story your family tells about you that you don\'t remember firsthand?',
      'Write about a family meal that represents something larger about your upbringing.',
      'Describe a moment of unexpected connection or understanding with a family member.'
    ]
  },
  {
    id: 'friendship',
    label: 'Friendship',
    prompts: [
      'Tell the story of how you met your closest friend.',
      'Describe a time a friend showed up for you when you really needed it.',
      'Write about a friendship that ended and what it taught you.',
      'What\'s the funniest thing that ever happened with a friend?',
      'Describe a moment when a stranger became a friend.'
    ]
  },
  {
    id: 'education',
    label: 'Education & Learning',
    prompts: [
      'Tell the story of a teacher who changed how you think.',
      'Describe a moment when you suddenly understood something that had confused you.',
      'Write about a time you taught someone else something important.',
      'What\'s the hardest thing you ever had to learn? What made it click?',
      'Describe a book, lecture, or conversation that opened a new world for you.'
    ]
  },
  {
    id: 'career',
    label: 'Career & Work',
    prompts: [
      'Tell the story of your first real job. What surprised you about the working world?',
      'Describe a project or accomplishment you\'re proud of. What made it meaningful?',
      'Write about a professional failure that redirected your path for the better.',
      'Describe the moment you realized what kind of work energizes you.',
      'Tell the story of a mentor or colleague who shaped your professional identity.'
    ]
  },
  {
    id: 'travel',
    label: 'Travel & Places',
    prompts: [
      'Describe a place you visited that changed your perspective on the world.',
      'Tell the story of getting lost somewhere — literally or figuratively.',
      'Write about a meal in a foreign place that you still remember vividly.',
      'Describe leaving home for the first time. What did you carry with you?',
      'Tell the story of a journey where the getting there mattered more than arriving.'
    ]
  },
  {
    id: 'challenge',
    label: 'Overcoming Challenges',
    prompts: [
      'Describe the hardest decision you ever had to make. How did you decide?',
      'Tell the story of a time you were afraid but did it anyway.',
      'Write about a period of your life when everything felt uncertain.',
      'Describe a failure that you\'re now grateful for.',
      'Tell the story of rebuilding something — a relationship, a career, your confidence.'
    ]
  },
  {
    id: 'joy',
    label: 'Moments of Joy',
    prompts: [
      'Describe a moment of pure, uncomplicated happiness.',
      'Tell the story of a surprise that delighted you.',
      'Write about a time you laughed so hard you couldn\'t breathe.',
      'Describe a small, ordinary moment that filled you with gratitude.',
      'Tell the story of an achievement that made you feel truly alive.'
    ]
  },
  {
    id: 'love',
    label: 'Love & Relationships',
    prompts: [
      'Describe the moment you knew you loved someone.',
      'Tell the story of a relationship that taught you what you needed.',
      'Write about a gesture of love — given or received — that was understated but powerful.',
      'Describe a heartbreak and what it revealed about what you value.',
      'Tell the story of an unexpected act of kindness from someone you love.'
    ]
  },
  {
    id: 'identity',
    label: 'Identity & Self-Discovery',
    prompts: [
      'Describe a moment when you realized you were different from who you thought you were.',
      'Tell the story of a habit or belief you outgrew.',
      'Write about a time when you stood up for something that mattered to you, even when it was hard.',
      'Describe the person you were five years ago. What would surprise them about you now?',
      'Tell the story of finding something you\'re passionate about.'
    ]
  },
  {
    id: 'creativity',
    label: 'Creativity & Expression',
    prompts: [
      'Describe the first time you made something you were proud of.',
      'Tell the story of a creative project that took on a life of its own.',
      'Write about a time when art, music, or writing helped you process something difficult.',
      'Describe your creative process — what does it feel like when ideas are flowing?',
      'Tell the story of sharing something you created with the world for the first time.'
    ]
  },
  {
    id: 'turning_point',
    label: 'Turning Points',
    prompts: [
      'Describe a single day that divided your life into "before" and "after".',
      'Tell the story of a choice that seemed small at the time but turned out to be pivotal.',
      'Write about a time someone said something that changed the course of your thinking.',
      'Describe the moment you committed to a major life change.',
      'Tell the story of an ending that was also a beginning.'
    ]
  }
];

const DEFAULT_CONFIG = {
  intervalHours: 24,
  enabled: true,
  lastPromptAt: null,
  lastPromptId: null
};

const DEFAULT_DATA = {
  version: 1,
  stories: [],
  usedPrompts: []
};

async function ensureDataDir() {
  await ensureDir(DATA_DIR);
}

async function loadStories() {
  await ensureDataDir();
  return readJSONFile(STORIES_FILE, DEFAULT_DATA);
}

async function saveStories(data) {
  await ensureDataDir();
  await writeFile(STORIES_FILE, JSON.stringify(data, null, 2));
}

async function loadConfig() {
  await ensureDataDir();
  return readJSONFile(CONFIG_FILE, DEFAULT_CONFIG);
}

async function saveConfig(config) {
  await ensureDataDir();
  await writeFile(CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Get all available themes with their prompt counts
 */
export function getThemes() {
  return PROMPT_THEMES.map(theme => ({
    id: theme.id,
    label: theme.label,
    promptCount: theme.prompts.length
  }));
}

/**
 * Pick the next prompt, cycling through themes and avoiding repeats
 */
export async function getNextPrompt() {
  const data = await loadStories();
  const usedPrompts = data.usedPrompts || [];

  // Build flat list of all prompts with IDs
  const allPrompts = PROMPT_THEMES.flatMap(theme =>
    theme.prompts.map((text, idx) => ({
      id: `${theme.id}-${idx}`,
      themeId: theme.id,
      themeLabel: theme.label,
      text
    }))
  );

  // Filter out used prompts
  let available = allPrompts.filter(p => !usedPrompts.includes(p.id));

  // If all prompts used, reset and start over
  if (available.length === 0) {
    data.usedPrompts = [];
    await saveStories(data);
    available = allPrompts;
  }

  // Pick from the least-used theme to keep balance
  const themeCounts = {};
  for (const story of data.stories) {
    themeCounts[story.themeId] = (themeCounts[story.themeId] || 0) + 1;
  }

  // Sort available prompts by theme usage (least written first)
  available.sort((a, b) => (themeCounts[a.themeId] || 0) - (themeCounts[b.themeId] || 0));

  return available[0];
}

/**
 * Get a specific prompt by ID
 */
export function getPromptById(promptId) {
  for (const theme of PROMPT_THEMES) {
    const idx = theme.prompts.findIndex((_, i) => `${theme.id}-${i}` === promptId);
    if (idx !== -1) {
      return {
        id: promptId,
        themeId: theme.id,
        themeLabel: theme.label,
        text: theme.prompts[idx]
      };
    }
  }
  return null;
}

/**
 * Save a story for a given prompt
 */
export async function saveStory({ promptId, content }) {
  const data = await loadStories();
  const prompt = getPromptById(promptId);

  const story = {
    id: uuidv4(),
    promptId,
    themeId: prompt?.themeId || 'unknown',
    themeLabel: prompt?.themeLabel || 'Unknown',
    promptText: prompt?.text || '',
    content,
    wordCount: content.split(/\s+/).filter(Boolean).length,
    createdAt: new Date().toISOString()
  };

  data.stories.push(story);

  // Mark prompt as used
  if (!data.usedPrompts) data.usedPrompts = [];
  if (!data.usedPrompts.includes(promptId)) {
    data.usedPrompts.push(promptId);
  }

  await saveStories(data);
  console.log(`📖 Autobiography story saved: ${story.themeLabel} (${story.wordCount} words)`);

  return story;
}

/**
 * Update an existing story
 */
export async function updateStory(storyId, content) {
  const data = await loadStories();
  const story = data.stories.find(s => s.id === storyId);

  if (!story) return null;

  story.content = content;
  story.wordCount = content.split(/\s+/).filter(Boolean).length;
  story.updatedAt = new Date().toISOString();

  await saveStories(data);
  console.log(`📖 Autobiography story updated: ${story.themeLabel} (${story.wordCount} words)`);

  return story;
}

/**
 * Delete a story
 */
export async function deleteStory(storyId) {
  const data = await loadStories();
  const idx = data.stories.findIndex(s => s.id === storyId);
  if (idx === -1) return null;

  const removed = data.stories.splice(idx, 1)[0];
  await saveStories(data);
  console.log(`📖 Autobiography story deleted: ${removed.themeLabel}`);

  return removed;
}

/**
 * Get all stories, optionally filtered by theme
 */
export async function getStories(themeId = null) {
  const data = await loadStories();
  let stories = data.stories;

  if (themeId) {
    stories = stories.filter(s => s.themeId === themeId);
  }

  // Sort newest first
  stories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  return stories;
}

/**
 * Get autobiography stats
 */
export async function getStats() {
  const data = await loadStories();
  const config = await loadConfig();

  const totalStories = data.stories.length;
  const totalWords = data.stories.reduce((sum, s) => sum + (s.wordCount || 0), 0);

  // Count stories per theme
  const byTheme = {};
  for (const story of data.stories) {
    byTheme[story.themeId] = (byTheme[story.themeId] || 0) + 1;
  }

  const totalPrompts = PROMPT_THEMES.reduce((sum, t) => sum + t.prompts.length, 0);
  const usedPrompts = (data.usedPrompts || []).length;

  return {
    totalStories,
    totalWords,
    byTheme,
    totalPrompts,
    usedPrompts,
    promptsRemaining: totalPrompts - usedPrompts,
    config: {
      enabled: config.enabled,
      intervalHours: config.intervalHours,
      lastPromptAt: config.lastPromptAt
    }
  };
}

/**
 * Get configuration
 */
export async function getConfig() {
  return loadConfig();
}

/**
 * Update configuration
 */
export async function updateConfig(updates) {
  const config = await loadConfig();
  const updated = { ...config, ...updates };
  await saveConfig(updated);
  console.log(`📖 Autobiography config updated: interval=${updated.intervalHours}h, enabled=${updated.enabled}`);
  return updated;
}

/**
 * Check if a new story prompt is due and create a notification if so.
 * Called by the autonomous job system or can be triggered manually.
 */
export async function checkAndPrompt() {
  const config = await loadConfig();

  if (!config.enabled) {
    return { prompted: false, reason: 'disabled' };
  }

  const now = Date.now();
  const intervalMs = (config.intervalHours || 24) * 60 * 60 * 1000;
  const lastPromptTime = config.lastPromptAt ? new Date(config.lastPromptAt).getTime() : 0;

  if (now - lastPromptTime < intervalMs) {
    return { prompted: false, reason: 'not_due' };
  }

  // Check if there's already an unread autobiography notification
  const alreadyNotified = await notificationExists(
    NOTIFICATION_TYPES.AUTOBIOGRAPHY_PROMPT,
    'type',
    'autobiography_prompt'
  );

  if (alreadyNotified) {
    return { prompted: false, reason: 'pending_notification' };
  }

  const prompt = await getNextPrompt();

  await addNotification({
    type: NOTIFICATION_TYPES.AUTOBIOGRAPHY_PROMPT,
    title: '5-Minute Story Time',
    description: `${prompt.themeLabel}: ${prompt.text}`,
    priority: 'low',
    link: `/digital-twin/autobiography?prompt=${prompt.id}`,
    metadata: {
      type: 'autobiography_prompt',
      promptId: prompt.id,
      themeId: prompt.themeId
    }
  });

  config.lastPromptAt = new Date().toISOString();
  config.lastPromptId = prompt.id;
  await saveConfig(config);

  console.log(`📖 Autobiography prompt sent: ${prompt.themeLabel} - ${prompt.text.substring(0, 50)}...`);

  return { prompted: true, prompt };
}
