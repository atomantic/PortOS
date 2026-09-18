/**
 * Autobiography Service
 *
 * Prompts the user on a regular basis to write 5-minute life stories, building
 * an autobiography over time. Every story answers a QUESTION — either one of
 * the thematic prompts below (where the question is often implied: "Describe
 * the house you grew up in") or a question the user writes themselves ("Why do
 * I like black licorice?"). That framing is what the storytelling-craft
 * evaluation scores against: a story that never answers its question has not
 * landed, however well written it is.
 *
 * Stories are stored as part of the digital twin data.
 */

import { EventEmitter } from 'events';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { atomicWrite, ensureDir, PATHS, readJSONFile } from '../lib/fileUtils.js';
import { deepMerge } from '../lib/objects.js';
import { recordTombstone } from '../lib/tombstones.js';
import { countWords } from '../lib/textUtils.js';
import {
  buildStoryCraftEvaluationPrompt,
  normalizeStoryCraftEvaluation
} from '../lib/storytellingCraft.js';
import {
  queueAutobiographyConfigWrite,
  queueAutobiographyStoriesWrite
} from './autobiographyFileQueues.js';
import { addNotification, NOTIFICATION_TYPES, PRIORITY_LEVELS } from './notifications.js';
import { getActiveProvider, getProviderById } from './providers.js';
import { callProviderAISimple, parseLLMJSON } from './aiProvider.js';

// Tiny pub/sub, mirroring meatspacePost.js's postConfigEvents: the reminder
// scheduler subscribes so ANY caller of updateConfig() reschedules the cron for
// free, without this module importing back into the scheduler (a service cycle).
export const autobiographyConfigEvents = new EventEmitter();

// How many story ideas a prompt notification offers. One would be a command;
// a short menu is an invitation, and the user picks whichever memory is
// actually live for them today.
export const PROMPT_SUGGESTION_COUNT = 3;

// The promptId stories written against the user's own question carry. Not a
// bank id, so getPromptById() returns null for it and the story's own
// promptText is the only question of record.
export const CUSTOM_PROMPT_ID = 'custom';

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
  enabled: false,
  lastPromptAt: null,
  lastPromptId: null,
  // Opt-in daily reminder at a chosen local time (default OFF), the same shape
  // and default the POST reminder uses. `enabled` above still governs the
  // interval-based autonomous job; this slice governs the time-of-day cron in
  // autobiographyReminder.js. Both funnel into sendStoryPrompt(), which is
  // idempotent for the day, so turning on both cannot double-nudge.
  reminder: { enabled: false, time: '09:00' }
};

const DEFAULT_DATA = {
  version: 1,
  stories: [],
  usedPrompts: [],
  // Tombstones for stories the user deleted (#3531) — peer sync unions stories
  // add-only, so without these a machine that still holds the story resurrects
  // it on the next cycle. Keyed on the story `id` (see deleteStory).
  deletedStories: []
};

async function loadStories() {
  await ensureDir(DATA_DIR);
  // Deep clone the default — readJSONFile hands the fallback back BY REFERENCE
  // on a missing file, so `data.stories.push(...)` / the deletedStories rewrite
  // below would otherwise mutate the module-level DEFAULT_DATA and leak the
  // previous caller's stories into the next fresh-install read.
  return readJSONFile(STORIES_FILE, structuredClone(DEFAULT_DATA), { strict: true });
}

async function saveStories(data) {
  await ensureDir(DATA_DIR);
  await atomicWrite(STORIES_FILE, data);
}

async function loadConfig() {
  await ensureDir(DATA_DIR);
  // Deep-merge onto a fresh clone of the defaults so a config written before
  // the `reminder` slice existed still reads back with it — otherwise the
  // scheduler would see `config.reminder` as undefined on every install that
  // saved settings before this shipped.
  const defaults = structuredClone(DEFAULT_CONFIG);
  const stored = await readJSONFile(CONFIG_FILE, defaults, { strict: true });
  return deepMerge(defaults, stored);
}

async function saveConfig(config) {
  await ensureDir(DATA_DIR);
  await atomicWrite(CONFIG_FILE, config);
}

// Stories written against a question the user typed themselves file under this
// pseudo-theme rather than 'unknown' — it is a real, nameable category (the
// questions they chose to answer), and it keeps the theme filter honest. Its id
// IS the custom promptId sentinel, so the two can never disagree.
export const CUSTOM_THEME = Object.freeze({ id: CUSTOM_PROMPT_ID, label: 'Your Own Question' });

/**
 * Get all available themes with their prompt counts.
 *
 * The custom pseudo-theme is included with a zero prompt count: it has no bank
 * entries by definition, but stories land in it and the filter row needs a chip
 * to reach them.
 */
export function getThemes() {
  return [
    ...PROMPT_THEMES.map(theme => ({
      id: theme.id,
      label: theme.label,
      promptCount: theme.prompts.length
    })),
    { ...CUSTOM_THEME, promptCount: 0 }
  ];
}

// The bank flattened once at module load — it is derived purely from the
// module-level PROMPT_THEMES, so rebuilding its 60 entries per request bought
// nothing. Frozen because callers receive these objects by reference.
const ALL_PROMPTS = Object.freeze(PROMPT_THEMES.flatMap(theme =>
  theme.prompts.map((text, idx) => Object.freeze({
    id: `${theme.id}-${idx}`,
    themeId: theme.id,
    themeLabel: theme.label,
    text
  }))
));

/**
 * Rank every still-unused prompt, least-written theme first, and hand back the
 * top `count`. Shared by getNextPrompt (count 1) and getPromptSuggestions.
 *
 * The ranking itself is a plain read — `getPromptSuggestions` runs on every
 * Autobiography tab open, and taking the stories write queue for it would
 * serialize a read-only page load behind any in-flight story save or
 * digital-twin sync write. Only the bank-exhaustion branch actually writes
 * (it resets `usedPrompts`), so only that branch enters the queue.
 *
 * Suggestions come from DISTINCT themes where the bank allows it: three
 * variations on childhood read as one idea, while childhood/work/travel read
 * as a genuine choice. Once the distinct-theme picks run out (late in a cycle,
 * or with `count` above the theme count) it falls back to the remaining
 * ranking rather than returning short.
 */
async function pickPrompts(count, excludePromptId) {
  const data = await loadStories();
  const usedPrompts = new Set(data.usedPrompts || []);

  let available = ALL_PROMPTS.filter(p => !usedPrompts.has(p.id));

  // If all prompts used, reset and start over
  if (available.length === 0) {
    await queueAutobiographyStoriesWrite(async () => {
      // Re-read inside the queue so the reset merges onto the freshest stories
      // rather than clobbering a save that landed while we were ranking.
      const current = await loadStories();
      current.usedPrompts = [];
      await saveStories(current);
    });
    available = [...ALL_PROMPTS];
  }

  // Exclude the currently displayed prompt so skip returns a different one
  if (excludePromptId) {
    const filtered = available.filter(p => p.id !== excludePromptId);
    if (filtered.length > 0) {
      available = filtered;
    }
  }

  // Pick from the least-used theme to keep balance
  const themeCounts = {};
  for (const story of data.stories) {
    themeCounts[story.themeId] = (themeCounts[story.themeId] || 0) + 1;
  }

  // Sort available prompts by theme usage (least written first)
  available.sort((a, b) => (themeCounts[a.themeId] || 0) - (themeCounts[b.themeId] || 0));

  // One theme's best prompt first, then everything else in the same ranked
  // order — so the menu reads as a genuine choice rather than three variations
  // on childhood, and still fills to `count` late in a cycle when fewer themes
  // than that are left.
  const seenThemes = new Set();
  const firstPerTheme = [];
  const remainder = [];
  for (const prompt of available) {
    (seenThemes.has(prompt.themeId) ? remainder : firstPerTheme).push(prompt);
    seenThemes.add(prompt.themeId);
  }

  return [...firstPerTheme, ...remainder].slice(0, count);
}

/**
 * Pick the next prompt, cycling through themes and avoiding repeats.
 * @param {string} [excludePromptId] - Prompt ID to exclude (used by skip to avoid returning the same prompt)
 */
export async function getNextPrompt(excludePromptId) {
  const [prompt] = await pickPrompts(1, excludePromptId);
  return prompt;
}

/**
 * A short menu of story ideas — what the daily prompt offers instead of one
 * assignment, and what the UI shows when the user opens the tab cold.
 */
export async function getPromptSuggestions(count = PROMPT_SUGGESTION_COUNT) {
  return pickPrompts(count);
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
export async function saveStory({ promptId, content, parentStoryId, customPromptText }) {
  return queueAutobiographyStoriesWrite(async () => {
    const data = await loadStories();
    const prompt = getPromptById(promptId);

    // For follow-up stories, use custom prompt text from the follow-up question
    const isFollowUp = !!parentStoryId;
    const parentStory = isFollowUp ? data.stories.find(s => s.id === parentStoryId) : null;

    // Resolve which of the three origins owns this story's theme ONCE, so the
    // id and the label can't come from different sources and leave a record
    // that's unfalsifiable after the fact. A follow-up inherits its parent's
    // theme; a bank prompt carries its own; a question the user typed
    // themselves has no bank prompt behind it and files under the custom
    // pseudo-theme, with its own promptText as the only question of record.
    const themeSource = isFollowUp
      ? parentStory
      : (prompt || (customPromptText ? CUSTOM_THEME : null));

    const story = {
      id: uuidv4(),
      promptId: isFollowUp ? `followup-${parentStoryId}` : promptId,
      themeId: themeSource?.themeId ?? themeSource?.id ?? 'unknown',
      themeLabel: themeSource?.themeLabel ?? themeSource?.label ?? 'Unknown',
      promptText: customPromptText || prompt?.text || '',
      content,
      wordCount: countWords(content),
      createdAt: new Date().toISOString(),
      ...(parentStoryId && { parentStoryId })
    };

    data.stories.push(story);

    // Mark prompt as used — only for real bank prompts. Pushing 'custom' or a
    // `followup-…` id would permanently occupy a slot in the used-list that no
    // bank prompt can ever match, delaying the cycle reset for nothing.
    if (prompt) {
      if (!data.usedPrompts) data.usedPrompts = [];
      if (!data.usedPrompts.includes(promptId)) {
        data.usedPrompts.push(promptId);
      }
    }

    await saveStories(data);
    console.log(`📖 Autobiography story saved: ${story.themeLabel} (${story.wordCount} words)`);

    return story;
  });
}

/**
 * Update an existing story
 */
export async function updateStory(storyId, content) {
  return queueAutobiographyStoriesWrite(async () => {
    const data = await loadStories();
    const story = data.stories.find(s => s.id === storyId);

    if (!story) return null;

    story.content = content;
    story.wordCount = countWords(content);
    story.updatedAt = new Date().toISOString();

    await saveStories(data);
    console.log(`📖 Autobiography story updated: ${story.themeLabel} (${story.wordCount} words)`);

    return story;
  });
}

/**
 * Delete a story
 *
 * Records a `deletedStories` tombstone alongside the removal so peer sync —
 * which unions stories ADD-ONLY by id — can't resurrect it from a machine that
 * still has the story, and so the delete propagates to that machine (#3531).
 * The tombstone keys on the story `id` rather than a derived natural key: story
 * ids are minted once by `saveStory` and travel with the record through sync
 * (`mergeAutobiographyStories` unions on `id`), so the same logical story
 * carries the same id on every peer.
 */
export async function deleteStory(storyId) {
  return queueAutobiographyStoriesWrite(async () => {
    const data = await loadStories();
    const idx = data.stories.findIndex(s => s.id === storyId);
    if (idx === -1) return null;

    const removed = data.stories.splice(idx, 1)[0];
    data.deletedStories = recordTombstone(data.deletedStories, removed.id, { keyField: 'id' });
    await saveStories(data);
    console.log(`📖 Autobiography story deleted: ${removed.themeLabel}`);

    return removed;
  });
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
  const updated = await queueAutobiographyConfigWrite(async () => {
    const config = await loadConfig();
    const merged = { ...config, ...updates };
    if (updates?.reminder) {
      // Merge rather than replace so a patch that only flips `enabled` keeps
      // the saved time, and stamp WHEN the slice last changed — the missed-slot
      // catch-up in autobiographyReminder.js uses it to refuse replaying a slot
      // that elapsed under a different (possibly disabled) configuration.
      merged.reminder = {
        ...config.reminder,
        ...updates.reminder,
        updatedAt: new Date().toISOString()
      };
    }
    await saveConfig(merged);
    console.log(`📖 Autobiography config updated: interval=${merged.intervalHours}h, enabled=${merged.enabled}, reminder=${merged.reminder?.enabled ? merged.reminder.time : 'off'}`);
    return merged;
  });
  // Emit AFTER the write succeeds so the reminder scheduler never reschedules
  // against a config change that did not persist. `updates` rides along so a
  // subscriber can gate on the slice it cares about instead of rescheduling on
  // every unrelated save.
  autobiographyConfigEvents.emit('autobiography-config:updated', { config: updated, updates });
  return updated;
}

/**
 * Map a chain depth to follow-up question guidance. Early in a chain the
 * questions broaden the scene (who/what/where/sensory); as the chain deepens
 * they pivot toward emotion, cause-and-effect, and finally reflection and
 * meaning — so each round builds a progressively richer narrative.
 */
export function depthGuidanceForChain(depth) {
  if (depth <= 1) {
    return 'Stay close to the scene: draw out concrete people, places, and sensory details they only touched on.';
  }
  if (depth === 2) {
    return 'Go beneath the surface: ask about the emotions, motivations, and relationships behind what they described.';
  }
  if (depth === 3) {
    return 'Probe cause and effect: ask how this moment shaped later choices, beliefs, or who they became.';
  }
  return 'Invite reflection and meaning: ask what this thread reveals about them now, looking back, and how it connects to the larger arc of their life.';
}

/**
 * Generate LLM-powered follow-up questions for a story.
 * Returns 2-3 deeper questions based on the story content. Questions become
 * progressively more reflective as the chain deepens (see depthGuidanceForChain).
 */
export async function generateFollowUps(storyId, providerId) {
  const data = await loadStories();
  const story = data.stories.find(s => s.id === storyId);
  if (!story) return { error: 'Story not found' };

  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();
  if (!provider) return { error: 'No AI provider available' };

  const model = provider.defaultModel;

  // Build chain context — include parent stories for deeper follow-ups
  const chainStories = [];
  let current = story;
  while (current) {
    chainStories.unshift(current);
    current = current.parentStoryId
      ? data.stories.find(s => s.id === current.parentStoryId)
      : null;
  }

  const chainContext = chainStories.map((s, i) =>
    `${i === 0 ? 'Original prompt' : `Follow-up #${i}`}: ${s.promptText}\nResponse: ${s.content}`
  ).join('\n\n');

  // Depth-aware guidance: the deeper into a chain we are, the more the
  // questions should shift from gathering new details toward reflection,
  // meaning, and synthesis — so the narrative grows progressively richer
  // rather than circling the same surface details.
  const depth = chainStories.length; // 1 = original story, 2+ = nth follow-up
  const depthGuidance = depthGuidanceForChain(depth);

  const prompt = `You are helping someone write their autobiography by asking thoughtful follow-up questions. Based on the story they just wrote, generate exactly 3 follow-up questions that dig deeper into specific details, emotions, or connections they mentioned.

Theme: ${story.themeLabel}
This is depth ${depth} in the story chain.

${chainContext}

Rules:
- Each question should reference a specific detail from their most recent response
- Questions should invite rich storytelling, not yes/no answers
- Keep questions under 30 words each
- Avoid repeating ground already covered earlier in the chain
- ${depthGuidance}

Return a JSON array of exactly 3 strings, nothing else. Example:
["Question 1?", "Question 2?", "Question 3?"]`;

  const result = await callProviderAISimple(provider, model, prompt, {
    temperature: 0.7,
    max_tokens: 500
  });

  if (result.error) return { error: result.error };

  let followUps;
  try { followUps = parseLLMJSON(result.text); } catch { /* invalid JSON */ }
  if (!Array.isArray(followUps) || followUps.length === 0) {
    return { error: 'Failed to parse follow-up questions from AI response' };
  }

  // Re-read inside the file queue so a story mutation that completed while the
  // provider was running is preserved in the write-back.
  const storedFollowUps = await queueAutobiographyStoriesWrite(async () => {
    const currentData = await loadStories();
    const currentStory = currentData.stories.find(s => s.id === storyId);
    if (!currentStory) return null;

    currentStory.followUpPrompts = followUps.slice(0, 3);
    currentStory.followUpsGeneratedAt = new Date().toISOString();
    await saveStories(currentData);
    return currentStory.followUpPrompts;
  });

  if (!storedFollowUps) return { error: 'Story not found' };

  console.log(`📖 Autobiography follow-ups generated for story ${storyId}: ${followUps.length} questions`);

  return { followUps: storedFollowUps };
}

/**
 * Get the chain of stories linked to a given story (parent + children)
 */
export async function getStoryChain(storyId) {
  const data = await loadStories();

  // Find all ancestors
  const ancestors = [];
  let current = data.stories.find(s => s.id === storyId);
  while (current?.parentStoryId) {
    const parent = data.stories.find(s => s.id === current.parentStoryId);
    if (parent) ancestors.unshift(parent);
    current = parent;
  }

  // Find the story itself
  const story = data.stories.find(s => s.id === storyId);
  if (!story) return [];

  // Find all descendants recursively
  const descendants = [];
  const findChildren = (parentId) => {
    const children = data.stories
      .filter(s => s.parentStoryId === parentId)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    for (const child of children) {
      descendants.push(child);
      findChildren(child.id);
    }
  };
  findChildren(storyId);

  return [...ancestors, story, ...descendants];
}

/**
 * Weave a story chain into a single cohesive first-person narrative.
 *
 * Takes the full chain for a story (ancestors → story → descendants, the same
 * ordering as getStoryChain) and asks the LLM to synthesize every prompt/answer
 * turn into one flowing memoir passage — the "progressively richer narrative"
 * the chained follow-ups were building toward. The result is returned to the
 * caller (not persisted as a story) so the user can review or copy it.
 */
export async function weaveChainNarrative(storyId, providerId) {
  const chain = await getStoryChain(storyId);
  if (chain.length === 0) return { error: 'Story not found' };

  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();
  if (!provider) return { error: 'No AI provider available' };

  const model = provider.defaultModel;

  const chainContext = chain.map((s, i) =>
    `${i === 0 ? 'Opening prompt' : `Follow-up #${i}`}: ${s.promptText}\nResponse: ${s.content}`
  ).join('\n\n');

  const themeLabel = chain[0]?.themeLabel || 'this period';

  const prompt = `You are a memoir editor. Below is a chain of autobiography prompts and the person's own responses, written over several sittings about ${themeLabel}. Weave them into a single cohesive first-person narrative passage.

${chainContext}

Rules:
- Write in the first person, in the person's own voice — preserve their phrasing, details, and tone
- Merge the separate responses into one flowing passage; do not list them as Q&A
- Keep every concrete detail they shared; do not invent facts, names, or events they did not mention
- Smooth transitions so the deeper follow-up reflections feel like a natural progression
- Return only the narrative prose, no preamble, headings, or commentary`;

  const result = await callProviderAISimple(provider, model, prompt, {
    temperature: 0.6,
    max_tokens: 2000,
    // First-person memoir prose that can name real works, people, and places —
    // exactly what a model hedges around without the IP-latitude clause.
    creative: true,
    op: 'autobiography-weave',
    opLabel: 'Weaving your story…'
  });

  if (result.error) return { error: result.error };

  const narrative = (result.text || '').trim();
  if (!narrative) return { error: 'AI returned an empty narrative' };

  console.log(`📖 Autobiography narrative woven for chain of ${chain.length} stories (root ${chain[0]?.id})`);

  return { narrative, storyCount: chain.length };
}

/**
 * Send one story-prompt notification offering a short menu of ideas.
 *
 * Deterministic — it picks from the on-disk prompt bank and makes NO provider
 * call, so it is safe on a cold install (AGENTS.md's AI Provider Usage Policy).
 *
 * This is the single notification path — both the interval-based autonomous job
 * (`checkAndPrompt`) and the time-of-day cron (`autobiographyReminder.js`) send
 * through it — but it does NOT decide whether a nudge is due. Each caller owns
 * a cadence guard appropriate to it: the job gates on `intervalHours` since
 * `lastPromptAt`, and the cron gates on whether a prompt already went out on
 * the user's local day (dailyReminderScheduler.js). Because this stamps
 * `lastPromptAt`, an install running both still cannot nudge twice.
 *
 * It deliberately does NOT gate on `notifications.exists(AUTOBIOGRAPHY_PROMPT)`:
 * that matches ANY notification of the type ever created, read or not, so it
 * would silence the daily prompt permanently after its very first nudge.
 */
export async function sendStoryPrompt() {
  return queueAutobiographyConfigWrite(sendStoryPromptUnqueued);
}

/**
 * The body of sendStoryPrompt, minus acquiring the config write queue.
 *
 * checkAndPrompt runs its due-check and this sender inside ONE queue task, so
 * two concurrent due-checks cannot both read the same stale `lastPromptAt` and
 * each send a prompt. The file write queue is a plain tail, not a re-entrant
 * lock, so that task cannot call the queue-acquiring wrapper.
 */
async function sendStoryPromptUnqueued(loadedConfig) {
  const suggestions = await getPromptSuggestions();
  const [prompt, ...alternates] = suggestions;
  if (!prompt) {
    return { prompted: false, reason: 'no_prompts_available' };
  }

  const alternateLine = alternates.length
    ? ` Or: ${alternates.map(p => p.text).join(' · ')}`
    : '';

  await addNotification({
    type: NOTIFICATION_TYPES.AUTOBIOGRAPHY_PROMPT,
    title: '5-Minute Story Time',
    description: `${prompt.themeLabel}: ${prompt.text}${alternateLine}`,
    priority: PRIORITY_LEVELS.LOW,
    link: `/digital-twin/autobiography?prompt=${prompt.id}`,
    metadata: {
      promptId: prompt.id,
      themeId: prompt.themeId,
      suggestions: suggestions.map(p => ({ id: p.id, themeId: p.themeId, themeLabel: p.themeLabel, text: p.text }))
    }
  });

  // checkAndPrompt already read the config inside this same queue task, so it
  // hands it down rather than paying for a second read of a file nothing else
  // can have touched in between.
  const config = loadedConfig || await loadConfig();
  config.lastPromptAt = new Date().toISOString();
  config.lastPromptId = prompt.id;
  await saveConfig(config);

  console.log(`📖 Autobiography prompt sent: ${prompt.themeLabel} - ${prompt.text.substring(0, 50)}... (+${alternates.length} more ideas)`);

  return { prompted: true, prompt, suggestions };
}

/**
 * Check if a new story prompt is due and create a notification if so.
 * Called by the autonomous job system or can be triggered manually.
 */
export async function checkAndPrompt() {
  return queueAutobiographyConfigWrite(async () => {
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

    return sendStoryPromptUnqueued(config);
  });
}

/**
 * Score a story against the storytelling rubric in lib/storytellingCraft.js —
 * the seven moves plus CART — and persist the result on the story.
 *
 * Explicitly user-triggered (a button, or the evaluate route): this is the one
 * provider call the autobiography feature makes outside follow-ups and weaving,
 * and nothing schedules it.
 */
export async function evaluateStory(storyId, providerId) {
  const data = await loadStories();
  const story = data.stories.find(s => s.id === storyId);
  if (!story) return { error: 'Story not found' };

  const provider = providerId
    ? await getProviderById(providerId)
    : await getActiveProvider();
  if (!provider) return { error: 'No AI provider available' };

  const result = await callProviderAISimple(
    provider,
    provider.defaultModel,
    buildStoryCraftEvaluationPrompt({ question: story.promptText, story: story.content }),
    {
      // Low temperature: a rubric score the user will act on should be the same
      // answer twice, not a different reading each time they press the button.
      temperature: 0.2,
      max_tokens: 2000,
      op: 'autobiography-evaluate',
      opLabel: 'Scoring your story…'
    }
  );

  if (result.error) return { error: result.error };

  let parsed;
  try { parsed = parseLLMJSON(result.text); } catch { /* invalid JSON */ }
  const evaluation = normalizeStoryCraftEvaluation(parsed);
  if (!evaluation) {
    return { error: 'Failed to parse the story evaluation from the AI response' };
  }
  evaluation.evaluatedAt = new Date().toISOString();

  // Re-read inside the file queue so a story edit that landed while the
  // provider was running is preserved in the write-back.
  const stored = await queueAutobiographyStoriesWrite(async () => {
    const currentData = await loadStories();
    const currentStory = currentData.stories.find(s => s.id === storyId);
    if (!currentStory) return null;
    currentStory.evaluation = evaluation;
    await saveStories(currentData);
    return currentStory.evaluation;
  });

  if (!stored) return { error: 'Story not found' };

  console.log(`📖 Autobiography story scored: ${story.themeLabel} — ${stored.overallScore}/${stored.maxScore}`);

  return { evaluation: stored };
}
