import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const context = vi.hoisted(() => ({ data: '', afterHydrate: null }));
vi.mock('../lib/paths.js', async importActual => {
  const actual = await importActual();
  return { ...actual, PATHS: { ...actual.PATHS, get data() { return context.data; } } };
});
vi.mock('./privateKeyStore.js', async importActual => {
  const actual = await importActual();
  return { ...actual, hydratePrivateKeys: async (...args) => {
    const hydrated = await actual.hydratePrivateKeys(...args);
    await context.afterHydrate?.(hydrated);
    return hydrated;
  } };
});
vi.mock('./userActions.js', () => ({ recordUserAction: vi.fn() }));
let settings;
let getCodeReviewDefaults;
let file;
beforeEach(async () => {
  context.afterHydrate = null;
  context.data = await mkdtemp(join(tmpdir(), 'review-settings-'));
  file = join(context.data, 'settings.json');
  vi.resetModules();
  settings = await import('./settings.js');
  ({ getCodeReviewDefaults } = await import('./codeReview.js'));
});
afterEach(async () => {
  await settings.flushSettingsLedger();
  await rm(context.data, { recursive: true, force: true });
});

it('rotates fallback reviewers after bridge writes and restores them after health clears', async () => {
  const config = { reviewerFallbackGroups: [['codex'], ['claude']] };
  await writeFile(file, JSON.stringify({ codeReview: config }));
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['codex']);

  const health = { codex: { pausedUntil: Date.now() + 60_000, reason: 'quota', lastFailureAt: Date.now() } };
  await writeFile(file, JSON.stringify({ codeReview: { ...config, reviewerHealth: health } }));
  // Ordinary settings reads keep their hot cache until a reviewer-selection read.
  expect((await settings.getSettings()).codeReview.reviewerHealth).toBeUndefined();
  expect(await getCodeReviewDefaults()).toMatchObject({ reviewers: ['claude'], reviewerHealth: health });
  expect((await settings.getSettings()).codeReview.reviewerHealth).toEqual(health);

  await writeFile(file, JSON.stringify({ codeReview: config }));
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['codex']);
});

it('detects same-size edits by mtime and serializes refresh behind an admitted save', async () => {
  await writeFile(file, JSON.stringify({ codeReview: { reviewers: ['codex'] } }).padEnd(80));
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['codex']);
  await writeFile(file, JSON.stringify({ codeReview: { reviewers: ['claude'] } }).padEnd(80));
  const future = new Date(Date.now() + 2000);
  await utimes(file, future, future);
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['claude']);

  let release;
  const admitted = new Promise(resolve => { release = resolve; });
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const save = settings.updateSettingsWith(async current => {
    entered();
    await admitted;
    return { ...current, codeReview: { reviewers: ['codex'] } };
  }, { skipUserAction: true });
  await started;
  const refresh = getCodeReviewDefaults();
  release();
  await save;
  expect((await refresh).reviewers).toEqual(['codex']);
});

it('invalidates corrupt settings without broadcasting an empty update, then observes repair', async () => {
  await writeFile(file, JSON.stringify({ codeReview: { reviewers: ['codex'] } }));
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['codex']);
  const updated = vi.fn();
  const invalidated = vi.fn();
  settings.settingsEvents.on('settings:updated', updated);
  settings.settingsEvents.on('settings:invalidated', invalidated);
  await writeFile(file, '{ truncated');
  expect((await getCodeReviewDefaults()).reviewers).toEqual([]);
  expect(updated).not.toHaveBeenCalled();
  expect(invalidated).toHaveBeenCalledTimes(1);
  await writeFile(file, JSON.stringify({ codeReview: { reviewers: ['claude'] } }));
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['claude']);
});

it('observes a bridge write landing after local persistence but before save completes', async () => {
  const config = { reviewerFallbackGroups: [['codex'], ['claude']] };
  await settings.updateSettings({ codeReview: config }, { skipUserAction: true });
  expect((await getCodeReviewDefaults()).reviewers).toEqual(['codex']);
  const health = { codex: { pausedUntil: Date.now() + 60_000, reason: 'quota', lastFailureAt: Date.now() } };
  context.afterHydrate = async current => {
    if (!current.localSave) return;
    context.afterHydrate = null;
    await writeFile(file, JSON.stringify({ ...current, codeReview: { ...config, reviewerHealth: health } }));
  };
  await settings.updateSettings({ localSave: true }, { skipUserAction: true });
  expect(await getCodeReviewDefaults()).toMatchObject({ reviewers: ['claude'], reviewerHealth: health });
});
