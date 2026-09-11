import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const fault = vi.hoisted(() => ({ path: null }));
vi.mock('fs/promises', async (original) => {
  const fs = await original();
  return { ...fs, readFile: (...args) => String(args[0]) === fault.path
    ? Promise.reject(Object.assign(new Error('injected read failure'), { code: 'EACCES' }))
    : fs.readFile(...args) };
});
vi.mock('../lib/fileUtils.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-personal-read-safety-'),
}));
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-personal-read-safety-'),
}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC', userLocalToday: async () => '2026-01-02' }));
vi.mock('./characterSkills.js', () => ({ getCharacterSkills: async () => [] }));
vi.mock('./characterMetrics.js', () => ({ getCharacterMetrics: async () => [] }));
vi.mock('./characterSignals.js', () => ({ createSignalContext: () => () => null }));
vi.mock('./cosTaskStore.js', () => ({ getAllTasks: async () => ({ user: { tasks: [] }, cos: { tasks: [] } }) }));
vi.mock('./jira.js', () => ({}));
vi.mock('./providers.js', () => ({ getActiveProvider: async () => null, getProviderById: async () => null }));
vi.mock('./aiProvider.js', () => ({ callProviderAISimple: vi.fn(), parseLLMJSON: vi.fn() }));
vi.mock('./promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('../lib/db.js', () => ({ query: async () => ({ rows: [] }), ensureSchema: async () => {} }));
vi.mock('./brainStorage.js', async () => {
  const { EventEmitter } = await import('events');
  return { brainEvents: new EventEmitter(), now: () => new Date().toISOString(),
    getAll: async () => [], get: async () => null };
});
vi.mock('./obsidian.js', () => ({}));
vi.mock('./notifications.js', () => ({ addNotification: vi.fn(), NOTIFICATION_TYPES: {}, exists: async () => false }));
vi.mock('./calendarSync.js', () => ({}));
vi.mock('./calendarAccounts.js', () => ({}));
vi.mock('./identity.js', () => ({ addProgressEntry: vi.fn(), getGoals: async () => ({ goals: [] }) }));

vi.mock('./cosAgentLifecycle.js', () => ({ getAgents: async () => [] }));
vi.mock('./digital-twin-meta.js', () => ({ loadMeta: async () => ({}), saveMeta: vi.fn() }));
vi.mock('./taste-questionnaire.js', () => ({ invalidateTasteProfileCache: vi.fn() }));

import { PATHS } from '../lib/fileUtils.js';
import { mergeIntoDay } from './appleHealthIngest.js';
import { saveStory, updateConfig } from './autobiography.js';
import { updateCharacterFields } from './character.js';
import { markDriverHandled } from './dailyDriver.js';
import { confirmEvent } from './dailyReview.js';
import { updateBirthDate } from './meatspace.js';
import { addCustomDrink } from './meatspaceAlcohol.js';
import { addActivity, addLifeEvent } from './meatspaceCalendar.js';
import { addCustomProduct } from './meatspaceNicotine.js';
import { setKochLevel } from './meatspacePostMorse.js';
import { saveStoredPostSession, saveStoredTrainingRun } from './postRunStore.js';
import { aggregateTwinEvidence } from './twinEnrichment.js';
import { listJournals, _clearObsidianLocationsCacheForTest } from './brainJournal.js';

import { updatePostConfig } from './meatspacePost.js';
import { createMemoryItem } from './meatspacePostMemory.js';
import { applySessionToReviewSchedule } from './meatspacePostReview.js';
import { onTaskCompleted } from './productivity.js';
import { recordUserAction } from './userActions.js';
import { getDigitalTwinSnapshot, applyDigitalTwinRemote } from './digital-twin-sync.js';

const cases = [
  ['POST config', () => join(PATHS.meatspace, 'post-config.json'), () => updatePostConfig({ enabled: true })],
  ['memory items', () => join(PATHS.meatspace, 'post-memory-items.json'), () => createMemoryItem({ title: 'Example', lines: ['Example line'] })],
  ['review schedule', () => join(PATHS.meatspace, 'post-review-schedule.json'), () => applySessionToReviewSchedule({ masteredSkills: [{ skillId: 'example' }] })],
  ['productivity', () => join(PATHS.cos, 'productivity.json'), () => onTaskCompleted({ completedAt: '2026-01-02T00:00:00Z', result: { success: true } })],
  ['user actions', () => join(PATHS.data, 'user-action-events.json'), () => recordUserAction({ type: 'cos.task.create', dedupeKey: 'example', actor: 'user' })],
  ['health day', () => join(PATHS.health, '2026-01-02.json'), () => mergeIntoDay('2026-01-02', 'steps', [{ date: '2026-01-02T12:00:00Z', qty: 1 }])],
  ['autobiography stories', () => join(PATHS.digitalTwin, 'autobiography/stories.json'), () => saveStory({ promptId: 'childhood-0', content: 'Example memory' })],
  ['autobiography config', () => join(PATHS.digitalTwin, 'autobiography/config.json'), () => updateConfig({ enabled: true })],
  ['character', () => join(PATHS.data, 'character.json'), () => updateCharacterFields({ name: 'Example character' })],
  ['daily driver', () => join(PATHS.data, 'daily-driver.json'), markDriverHandled],
  ['daily review', () => join(PATHS.calendar, 'daily-reviews/2026-01-02.json'), () => confirmEvent('2026-01-02', { eventId: 'example', happened: false })],
  ['meatspace config', () => join(PATHS.meatspace, 'config.json'), () => updateBirthDate('2000-01-01', { syncGoals: false })],
  ['custom drinks', () => join(PATHS.meatspace, 'custom-drinks.json'), () => addCustomDrink({ name: 'Example', oz: 12, abv: 5 })],
  ['custom nicotine', () => join(PATHS.meatspace, 'custom-nicotine-products.json'), () => addCustomProduct({ name: 'Example', nicotineMg: 1 })],
  ['activities', () => join(PATHS.meatspace, 'activities.json'), () => addActivity({ name: 'Example', hoursPerWeek: 1 })],
  ['life events', () => join(PATHS.meatspace, 'life-events.json'), () => addLifeEvent({ name: 'Example', date: '2026-01-02' })],
  ['Morse progress', () => join(PATHS.meatspace, 'post-morse-progress.json'), () => setKochLevel({ kochLevel: 3 })],
  ['POST sessions', () => join(PATHS.meatspace, 'post-sessions.json'), () => saveStoredPostSession({ id: 'example-run', date: '2026-01-02' })],
  ['POST training', () => join(PATHS.meatspace, 'post-training-log.json'), () => saveStoredTrainingRun({ id: 'example-run', localDay: '2026-01-02', attempts: [{ id: 'example-attempt', skill: 'memory' }] })],
  ['taste evidence', () => join(PATHS.digitalTwin, 'taste-observed.json'), aggregateTwinEvidence],
];

beforeEach(async () => {
  fault.path = null;
  _clearObsidianLocationsCacheForTest();
  await rm(PATHS.data, { recursive: true, force: true });
  await mkdir(PATHS.data, { recursive: true });
});
afterAll(cleanupTempDataRoots);

async function seed(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes);
}

describe.each(cases)('%s persistence boundary', (_name, pathFor, mutate) => {
  it('preserves unreadable bytes, rejects read faults, then initializes only when absent', async () => {
    const path = pathFor();
    for (const bytes of ['{"retained":', '', 'not json']) {
      await seed(path, bytes);
      await expect(mutate()).rejects.toThrow(/Unreadable JSON file/);
      expect(await readFile(path, 'utf8')).toBe(bytes);
    }
    await seed(path, '{}');
    fault.path = path;
    await expect(mutate()).rejects.toThrow(/Unreadable JSON file/);
    fault.path = null;
    expect(await readFile(path, 'utf8')).toBe('{}');
    await rm(path);
    await mutate();
    expect(JSON.parse(await readFile(path, 'utf8'))).toBeTruthy();
  });
});

it('retains existing autobiography records while appending after a repair', async () => {
  const path = join(PATHS.digitalTwin, 'autobiography/stories.json');
  await seed(path, '{');
  await expect(saveStory({ promptId: 'example', content: 'New story' })).rejects.toThrow();
  const existing = { id: 'retained-story', content: 'Earlier story', customField: 'preserve' };
  await seed(path, JSON.stringify({ stories: [existing], usedPrompts: ['prior'], deletedStories: [{ id: 'deleted' }] }));
  await saveStory({ promptId: 'example', content: 'New story' });
  const saved = JSON.parse(await readFile(path, 'utf8'));
  expect(saved.stories[0]).toEqual(existing);
  expect(saved.stories).toHaveLength(2);
  expect(saved.deletedStories).toEqual([{ id: 'deleted' }]);
});

it('retains the user interpretation while rebuilding taste evidence', async () => {
  const path = join(PATHS.digitalTwin, 'taste-observed.json');
  await seed(path, JSON.stringify({ interpretation: { text: 'Retained interpretation' } }));
  await aggregateTwinEvidence();
  expect(JSON.parse(await readFile(path, 'utf8')).interpretation).toEqual({ text: 'Retained interpretation' });
});

it('does not cache a failed Obsidian map load and retries after repair', async () => {
  const path = join(PATHS.brain, 'journal-obsidian-locations.json');
  await seed(path, '{');
  await expect(listJournals()).rejects.toThrow(/Unreadable JSON file/);
  expect(await readFile(path, 'utf8')).toBe('{');
  await seed(path, '{}');
  await expect(listJournals()).resolves.toEqual({ records: [], total: 0 });
});

it('blocks Digital Twin merge and export on unreadable local records, then preserves repaired history', async () => {
  const path = join(PATHS.digitalTwin, 'autobiography/stories.json');
  const incoming = { autobiography: { stories: { stories: [{ id: 'incoming', content: 'New', createdAt: '2026-02-01' }] } } };
  await seed(path, '{');
  await expect(getDigitalTwinSnapshot()).rejects.toThrow(/Unreadable JSON file/);
  await expect(applyDigitalTwinRemote(incoming)).rejects.toThrow(/Unreadable JSON file/);
  expect(await readFile(path, 'utf8')).toBe('{');
  await seed(path, JSON.stringify({ stories: [{ id: 'retained', content: 'Earlier', createdAt: '2026-01-01' }] }));
  await applyDigitalTwinRemote(incoming);
  expect(JSON.parse(await readFile(path, 'utf8')).stories.map(story => story.id).sort()).toEqual(['incoming', 'retained']);
});
