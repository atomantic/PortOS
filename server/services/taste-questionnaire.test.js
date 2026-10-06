import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

// taste-questionnaire binds PATHS.digitalTwin at module load; makePathsProxy
// re-roots it (and every other data/-rooted member) into the temp tree so tests
// never touch the real install profile.
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-taste-' });

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makeProxy(actual);
});

// Avoid digitalTwinEvents side effects during answer submit
vi.mock('./digital-twin-meta.js', async importOriginal => ({
  ...await importOriginal(),
  digitalTwinEvents: { emit: vi.fn() },
}));

// Drive the provider boundary directly so each "Go deeper" outcome is reachable
// without a live LLM. Re-imported per test because beforeEach resets the module
// registry, which mints fresh spies for each generation.
vi.mock('./aiProvider.js', () => ({
  resolveTextProvider: vi.fn(),
  callProviderAISimple: vi.fn(),
}));

beforeEach(() => {
  vi.resetModules();
});

afterAll(() => {
  cleanup();
});

describe('getNextQuestion progress', () => {
  it('reports core index, not total responses, after follow-ups', async () => {
    const taste = await import('./taste-questionnaire.js');

    // Core Q1
    let next = await taste.getNextQuestion('food');
    expect(next.questionId).toBe('food-core-1');
    expect(next.progress).toEqual({
      current: 1,
      coreTotal: 3,
      totalAnswered: 0,
    });

    // Answer with a spice trigger so a follow-up is queued
    await taste.submitAnswer('food', 'food-core-1', 'I love intense spice and heat');

    next = await taste.getNextQuestion('food');
    expect(next.isFollowUp).toBe(true);
    expect(next.questionId).toBe('food-fu-spice');
    // Follow-up still anchors progress to the parent core question
    expect(next.progress.current).toBe(1);
    expect(next.progress.coreTotal).toBe(3);
    expect(next.progress.totalAnswered).toBe(1);

    await taste.submitAnswer('food', 'food-fu-spice', 'Thai and Sichuan especially');

    // Core Q2 — must be "2 of 3", not "3 of 3" (responses.length + 1)
    next = await taste.getNextQuestion('food');
    expect(next.questionId).toBe('food-core-2');
    expect(next.isFollowUp).toBe(false);
    expect(next.progress).toEqual({
      current: 2,
      coreTotal: 3,
      totalAnswered: 2,
    });

    await taste.submitAnswer(
      'food',
      'food-core-2',
      'I cook improvisationally, rarely following recipes'
    );

    next = await taste.getNextQuestion('food');
    // Improvisational answer triggers food-fu-improv
    expect(next.isFollowUp).toBe(true);
    expect(next.progress.current).toBe(2);
    expect(next.progress.coreTotal).toBe(3);

    await taste.submitAnswer('food', next.questionId, 'Yes, freestyle almost always');

    // Core Q3 after two cores + two follow-ups → still "3 of 3", never "5 of 3"
    next = await taste.getNextQuestion('food');
    expect(next.questionId).toBe('food-core-3');
    expect(next.isFollowUp).toBe(false);
    expect(next.progress).toEqual({
      current: 3,
      coreTotal: 3,
      totalAnswered: 4,
    });
    expect(next.progress.current).toBeLessThanOrEqual(next.progress.coreTotal);
  });

  it('starts at Question 1 of N with no prior responses', async () => {
    const taste = await import('./taste-questionnaire.js');
    await taste.resetSection('movies');

    const next = await taste.getNextQuestion('movies');
    expect(next.questionId).toBe('movies-core-1');
    expect(next.progress.current).toBe(1);
    expect(next.progress.coreTotal).toBe(3);
    expect(next.progress.totalAnswered).toBe(0);
  });
});

describe('generatePersonalizedTasteQuestion outcomes', () => {
  const PROVIDER = { id: 'provider-1', name: 'Example Provider', defaultModel: 'model-1' };

  // Identity context is aggregated partly from *other* sections' taste responses, so
  // answering in `food` is enough to make a `movies` question well-founded.
  const seedIdentityContext = (taste) =>
    taste.submitAnswer('food', 'food-core-1', 'Sichuan and Thai, the hotter the better');

  const clearIdentityContext = async (taste) => {
    for (const sectionId of Object.keys(taste.TASTE_SECTIONS)) {
      await taste.resetSection(sectionId);
    }
  };

  it('reports no-context — the one outcome that is really about missing documents', async () => {
    const taste = await import('./taste-questionnaire.js');
    await clearIdentityContext(taste);

    expect(await taste.generatePersonalizedTasteQuestion('movies')).toEqual({
      question: null,
      reason: 'no-context',
    });
  });

  it('reports unknown-section rather than borrowing the missing-documents reason', async () => {
    const taste = await import('./taste-questionnaire.js');

    expect(await taste.generatePersonalizedTasteQuestion('not-a-real-section')).toEqual({
      question: null,
      reason: 'unknown-section',
    });
  });

  it('reports no-provider rather than blaming the user documents that do exist', async () => {
    const { resolveTextProvider } = await import('./aiProvider.js');
    resolveTextProvider.mockResolvedValue(null);
    const taste = await import('./taste-questionnaire.js');
    await seedIdentityContext(taste);

    expect(await taste.generatePersonalizedTasteQuestion('movies')).toEqual({
      question: null,
      reason: 'no-provider',
    });
  });

  it('throws AI_PROVIDER_ERROR instead of collapsing a provider failure into "nothing to ask"', async () => {
    const { resolveTextProvider, callProviderAISimple } = await import('./aiProvider.js');
    resolveTextProvider.mockResolvedValue(PROVIDER);
    callProviderAISimple.mockResolvedValue({ error: 'Provider returned 401: invalid key' });
    const taste = await import('./taste-questionnaire.js');
    await seedIdentityContext(taste);

    // Must reject — a 200-null here is exactly what made a provider failure look
    // like "you haven't written enough identity documents" (#2733).
    await expect(taste.generatePersonalizedTasteQuestion('movies')).rejects.toMatchObject({
      code: 'AI_PROVIDER_ERROR',
      status: 502,
      // Load-bearing: warning severity keeps this off the global `error:notified`
      // channel, so useErrorNotifications doesn't red-toast it on top of the
      // ai:status toast that already named the provider's reason. Dropping it
      // silently restores the double toast #2669 removed.
      severity: 'warning',
      message: expect.stringContaining('invalid key'),
    });
  });

  it('returns the question with reason null on success', async () => {
    const { resolveTextProvider, callProviderAISimple } = await import('./aiProvider.js');
    resolveTextProvider.mockResolvedValue(PROVIDER);
    callProviderAISimple.mockResolvedValue({ text: '  Which film would you rewatch forever?  ' });
    const taste = await import('./taste-questionnaire.js');
    await seedIdentityContext(taste);

    const result = await taste.generatePersonalizedTasteQuestion('movies');
    expect(result.reason).toBeNull();
    expect(result.question).toMatchObject({
      text: 'Which film would you rewatch forever?',
      isPersonalized: true,
      section: 'movies',
    });
  });
});

// #9785: taste-profile.json has one write owner. A summary's provider call runs
// outside the mutation queue, so an accepted peer sync (or a local reset) can
// land mid-generation — the summary must never republish its pre-call snapshot.
describe('summary generation vs concurrent writers', () => {
  const PROVIDER = { id: 'provider-1', name: 'Example Provider', defaultModel: 'model-1' };
  const T0 = '2026-01-01T00:00:00.000Z';
  const T1 = '2026-01-02T00:00:00.000Z';

  const profilePath = () => join(tempRoot, 'digital-twin', 'taste-profile.json');
  const aestheticsPath = () => join(tempRoot, 'digital-twin', 'AESTHETICS.md');
  const readDisk = async () => JSON.parse(await readFile(profilePath(), 'utf-8'));
  const answer = (questionId, text, answeredAt = T0) => ({ questionId, answer: text, answeredAt });
  const section = (responses) => ({ status: 'in_progress', responses, summary: null });

  const seedProfile = async (sections) => {
    await mkdir(join(tempRoot, 'digital-twin'), { recursive: true });
    await writeFile(profilePath(), JSON.stringify({
      version: '1.0.0', createdAt: T0, updatedAt: T0, profileSummary: null, lastSessionAt: T0, sections,
    }));
  };

  // A peer snapshot as `getDigitalTwinSnapshot` ships it; older updatedAt so the
  // only effect is the response union.
  const peerTaste = (sections) => ({ version: '1.0.0', updatedAt: T0, sections });

  // Hold the provider open until the test releases it, so writers can interleave.
  const holdProvider = async () => {
    const { resolveTextProvider, callProviderAISimple } = await import('./aiProvider.js');
    resolveTextProvider.mockResolvedValue(PROVIDER);
    let release;
    callProviderAISimple.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    return {
      started: () => vi.waitFor(() => expect(callProviderAISimple).toHaveBeenCalledTimes(1)),
      release: (text) => release({ text }),
    };
  };

  const loadModules = async () => ({
    taste: await import('./taste-questionnaire.js'),
    sync: await import('./digital-twin-sync.js'),
  });

  it('keeps an answer synced during a section summary and rejects the stale summary', async () => {
    await seedProfile({ movies: section([answer('movies-core-1', 'Example Film One')]) });
    const { taste, sync } = await loadModules();
    const provider = await holdProvider();

    const pending = taste.generateSectionSummary('movies');
    pending.catch(() => {});
    await provider.started();

    // Completing while the provider is still held proves the LLM call is outside the queue.
    const synced = await sync.applyDigitalTwinRemote({
      taste: peerTaste({ movies: section([answer('movies-core-2', 'Example Genre', T1)]) }),
    });
    expect(synced.applied).toBe(true);

    provider.release('### Movies & Film Profile\n- stale');
    await expect(pending).rejects.toMatchObject({ status: 409, code: 'TASTE_SUMMARY_STALE' });

    const disk = await readDisk();
    expect(disk.sections.movies.responses.map(r => r.questionId).sort()).toEqual(['movies-core-1', 'movies-core-2']);
    expect(disk.sections.movies.summary).toBeNull();
    expect((await taste.getSectionResponses('movies')).map(r => r.questionId).sort())
      .toEqual(['movies-core-1', 'movies-core-2']);
  });

  it('saves an unchanged-input summary onto the latest record without dropping a concurrent sync', async () => {
    await seedProfile({
      movies: section([answer('movies-core-1', 'Example Film One')]),
      food: section([]),
    });
    const { taste, sync } = await loadModules();
    const provider = await holdProvider();

    const pending = taste.generateSectionSummary('movies');
    await provider.started();
    await sync.applyDigitalTwinRemote({
      taste: peerTaste({ food: section([answer('food-core-1', 'Example Cuisine', T1)]) }),
    });
    provider.release('### Movies & Film Profile\n- fresh');

    await expect(pending).resolves.toEqual({ section: 'movies', summary: '### Movies & Film Profile\n- fresh' });
    const disk = await readDisk();
    expect(disk.sections.movies.summary).toBe('### Movies & Film Profile\n- fresh');
    expect(disk.sections.food.responses.map(r => r.questionId)).toEqual(['food-core-1']);
    expect((await taste.getSectionResponses('food')).map(r => r.questionId)).toEqual(['food-core-1']);
  });

  it('rejects an overall summary whose inputs were reset, without writing it or AESTHETICS.md', async () => {
    await seedProfile({
      movies: section([answer('movies-core-1', 'Example Film One')]),
      music: section([answer('music-core-1', 'Example Album')]),
    });
    await writeFile(aestheticsPath(), '# Aesthetic Preferences\n\nexisting\n');
    const { taste } = await loadModules();
    const provider = await holdProvider();

    const pending = taste.generateOverallSummary();
    pending.catch(() => {});
    await provider.started();
    await taste.resetSection('music');
    provider.release('### Unified Taste Profile\n- stale');

    await expect(pending).rejects.toMatchObject({ status: 409, code: 'TASTE_SUMMARY_STALE' });
    const disk = await readDisk();
    expect(disk.profileSummary).toBeNull();
    expect(disk.sections.music.responses).toEqual([]);
    expect(disk.sections.movies.responses.map(r => r.questionId)).toEqual(['movies-core-1']);
    expect(await readFile(aestheticsPath(), 'utf-8')).toBe('# Aesthetic Preferences\n\nexisting\n');
  });

  it('serializes a cold local answer with an overlapping peer merge so neither is lost', async () => {
    await seedProfile({ food: section([]) });
    const { taste, sync } = await loadModules();

    await Promise.all([
      taste.submitAnswer('food', 'food-core-1', 'Example Cuisine'),
      sync.applyDigitalTwinRemote({
        taste: peerTaste({ food: section([answer('food-core-2', 'Example Cooking Style', T1)]) }),
      }),
    ]);

    const ids = (await readDisk()).sections.food.responses.map(r => r.questionId).sort();
    expect(ids).toEqual(['food-core-1', 'food-core-2']);
    expect((await taste.getSectionResponses('food')).map(r => r.questionId).sort()).toEqual(ids);
  });

  it('refuses to mutate over a corrupt profile instead of rewriting defaults', async () => {
    await mkdir(join(tempRoot, 'digital-twin'), { recursive: true });
    await writeFile(profilePath(), '{ not json');
    const { taste } = await loadModules();

    await expect(taste.submitAnswer('food', 'food-core-1', 'Example Cuisine'))
      .rejects.toMatchObject({ code: 'UNREADABLE_STORE' });
    expect(await readFile(profilePath(), 'utf-8')).toBe('{ not json');
  });
});
