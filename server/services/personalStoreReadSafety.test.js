import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  overrides: { dataPath: (...parts) => join(lazyTempDataRoot('portos-personal-read-safety-'), ...parts) },
}));
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), {
  dataRoot: () => lazyTempDataRoot('portos-personal-read-safety-'),
  overrides: { dataPath: (...parts) => join(lazyTempDataRoot('portos-personal-read-safety-'), ...parts) },
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

vi.mock('./settings.js', async () => {
  const { EventEmitter } = await import('events');
  return { settingsEvents: new EventEmitter(), getSettings: async () => ({
    mortalloom: { enabled: false, path: join(lazyTempDataRoot('portos-personal-read-safety-'), 'mortal-source.json') },
  }) };
});
vi.mock('./cosAgentLifecycle.js', () => ({ getAgents: async () => [] }));
vi.mock('./digital-twin-meta.js', () => ({ loadMeta: async () => ({}), saveMeta: vi.fn() }));
vi.mock('./taste-questionnaire.js', () => ({ invalidateTasteProfileCache: vi.fn() }));

import { PATHS } from '../lib/fileUtils.js';
let { mergeIntoDay } = {};
let { saveStory, updateConfig } = {};
let { updateCharacterFields } = {};
let { markDriverHandled } = {};
let { confirmEvent } = {};
let { updateBirthDate } = {};
let { addCustomDrink, logDrink } = {};
let { addActivity, addLifeEvent } = {};
let { addCustomProduct, logNicotine } = {};
let { setKochLevel } = {};
let { saveStoredPostSession, saveStoredTrainingRun } = {};
let { aggregateTwinEvidence } = {};
let { listJournals, _clearObsidianLocationsCacheForTest } = {};

let { updatePostConfig } = {};
let { createMemoryItem } = {};
let { applySessionToReviewSchedule } = {};
let { onTaskCompleted } = {};
let { recordUserAction } = {};
let { getDigitalTwinSnapshot, applyDigitalTwinRemote } = {};


// Load service boundaries only after the isolated filesystem and dependency mocks are installed.
beforeAll(async () => {
  ({ mergeIntoDay } = await import('./appleHealthIngest.js'));
  ({ saveStory, updateConfig } = await import('./autobiography.js'));
  ({ updateCharacterFields } = await import('./character.js'));
  ({ markDriverHandled } = await import('./dailyDriver.js'));
  ({ confirmEvent } = await import('./dailyReview.js'));
  ({ updateBirthDate } = await import('./meatspace.js'));
  ({ addCustomDrink, logDrink } = await import('./meatspaceAlcohol.js'));
  ({ addActivity, addLifeEvent } = await import('./meatspaceCalendar.js'));
  ({ addCustomProduct, logNicotine } = await import('./meatspaceNicotine.js'));
  ({ setKochLevel } = await import('./meatspacePostMorse.js'));
  ({ saveStoredPostSession, saveStoredTrainingRun } = await import('./postRunStore.js'));
  ({ aggregateTwinEvidence } = await import('./twinEnrichment.js'));
  ({ listJournals, _clearObsidianLocationsCacheForTest } = await import('./brainJournal.js'));
  ({ updatePostConfig } = await import('./meatspacePost.js'));
  ({ createMemoryItem } = await import('./meatspacePostMemory.js'));
  ({ applySessionToReviewSchedule } = await import('./meatspacePostReview.js'));
  ({ onTaskCompleted } = await import('./productivity.js'));
  ({ recordUserAction } = await import('./userActions.js'));
  ({ getDigitalTwinSnapshot, applyDigitalTwinRemote } = await import('./digital-twin-sync.js'));
});

let importToPortOS;
beforeAll(async () => { ({ importToPortOS } = await import('./mortalLoomStore.js')); });

const cases = [
  ['alcohol daily log', () => join(PATHS.meatspace, 'daily-log.json'), () => logDrink({ name: 'Example', oz: 12, abv: 5, date: '2026-01-02' })],
  ['nicotine daily log', () => join(PATHS.meatspace, 'daily-log.json'), () => logNicotine({ product: 'Example', mgPerUnit: 1, date: '2026-01-02' })],
  ['POST config', () => join(PATHS.meatspace, 'post-config.json'), () => updatePostConfig({ enabled: true })],
  ['memory items', () => join(PATHS.meatspace, 'post-memory-items.json'), () => createMemoryItem({ title: 'Example', lines: ['Example line'] })],
  ['review schedule', () => join(PATHS.meatspace, 'post-review-schedule.json'), () => applySessionToReviewSchedule({ masteredSkills: [{ skillId: 'example' }] })],
  ['productivity', () => join(PATHS.cos, 'productivity.json'), () => onTaskCompleted({ completedAt: '2026-01-02T00:00:00Z', result: { success: true } })],
  ['user actions', () => join(PATHS.data, 'user-action-events.json'), () => recordUserAction({ type: 'cos.task.create', dedupeKey: 'example', actor: 'user' })],
  ['health day', () => join(PATHS.health, '2026-01-02.json'), () => mergeIntoDay('2026-01-02', 'steps', [{ date: '2026-01-02T12:00:00Z', qty: 1 }])],
  ['autobiography stories', () => join(PATHS.digitalTwin, 'autobiography/stories.json'), () => saveStory({ promptId: 'childhood-0', content: 'Example memory' })],
  ['autobiography config', () => join(PATHS.digitalTwin, 'autobiography/config.json'), () => updateConfig({ enabled: true })],
  ['character', () => join(PATHS.data, 'character.json'), () => updateCharacterFields({ name: 'Example character' })],
  ['daily driver', () => join(PATHS.data, 'daily-driver.json'), () => markDriverHandled()],
  ['daily review', () => join(PATHS.calendar, 'daily-reviews/2026-01-02.json'), () => confirmEvent('2026-01-02', { eventId: 'example', happened: false })],
  ['meatspace config', () => join(PATHS.meatspace, 'config.json'), () => updateBirthDate('2000-01-01', { syncGoals: false })],
  ['custom drinks', () => join(PATHS.meatspace, 'custom-drinks.json'), () => addCustomDrink({ name: 'Example', oz: 12, abv: 5 })],
  ['custom nicotine', () => join(PATHS.meatspace, 'custom-nicotine-products.json'), () => addCustomProduct({ name: 'Example', nicotineMg: 1 })],
  ['activities', () => join(PATHS.meatspace, 'activities.json'), () => addActivity({ name: 'Example', hoursPerWeek: 1 })],
  ['life events', () => join(PATHS.meatspace, 'life-events.json'), () => addLifeEvent({ name: 'Example', date: '2026-01-02' })],
  ['Morse progress', () => join(PATHS.meatspace, 'post-morse-progress.json'), () => setKochLevel({ kochLevel: 3 })],
  ['POST sessions', () => join(PATHS.meatspace, 'post-sessions.json'), () => saveStoredPostSession({ id: 'example-run', date: '2026-01-02' })],
  ['POST training', () => join(PATHS.meatspace, 'post-training-log.json'), () => saveStoredTrainingRun({ id: 'example-run', localDay: '2026-01-02', attempts: [{ id: 'example-attempt', skill: 'memory' }] })],
  ['taste evidence', () => join(PATHS.digitalTwin, 'taste-observed.json'), () => aggregateTwinEvidence()],
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

it('checks the legacy goals mirror before changing the canonical birth date', async () => {
  const configPath = join(PATHS.meatspace, 'config.json');
  const goalsPath = join(PATHS.digitalTwin, 'goals.json');
  const config = JSON.stringify({ birthDate: '2000-01-01' });
  await seed(configPath, config);
  await seed(goalsPath, '{');
  await expect(updateBirthDate('2001-01-01')).rejects.toThrow(/Unreadable JSON file/);
  expect(await readFile(configPath, 'utf8')).toBe(config);
  expect(await readFile(goalsPath, 'utf8')).toBe('{');
});

it('preflights MortalLoom import destinations and preserves repaired records on retry', async () => {
  const source = join(PATHS.data, 'mortal-source.json');
  const goalsPath = join(PATHS.digitalTwin, 'goals.json');
  const alcoholPath = join(PATHS.meatspace, 'alcohol-drinks.json');
  const goals = JSON.stringify({ goals: [{ id: 'retained-goal' }] });
  await seed(source, JSON.stringify({ goals: [{ id: 'incoming-goal' }], alcoholDrinks: [{ id: 'incoming-drink' }] }));
  await seed(goalsPath, goals);
  await seed(alcoholPath, '{');
  await expect(importToPortOS()).rejects.toThrow(/Unreadable JSON file/);
  expect(await readFile(goalsPath, 'utf8')).toBe(goals);
  expect(await readFile(alcoholPath, 'utf8')).toBe('{');
  await seed(alcoholPath, JSON.stringify([{ id: 'retained-drink' }]));
  await expect(importToPortOS()).resolves.toMatchObject({ ok: true });
  expect(JSON.parse(await readFile(goalsPath, 'utf8')).goals.map(goal => goal.id)).toEqual(['retained-goal', 'incoming-goal']);
  expect(JSON.parse(await readFile(alcoholPath, 'utf8')).map(drink => drink.id)).toEqual(['retained-drink', 'incoming-drink']);
});
