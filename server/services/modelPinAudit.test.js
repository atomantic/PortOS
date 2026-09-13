import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./providers.js', () => ({ listProviders: vi.fn() }));
vi.mock('./notifications.js', () => ({ removeByMetadata: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(), updateSettingsWith: vi.fn() }));
vi.mock('./taskSchedule.js', () => ({ loadSchedule: vi.fn(), updateTaskInterval: vi.fn() }));
vi.mock('./apps.js', () => ({
  getActiveApps: vi.fn(),
  updateAppTaskTypeOverride: vi.fn(),
}));
// The per-record source (#7326) owns its own SQL and is covered in
// modelPinRecords.test.js; here it stands in for 'a source that yields pins',
// so the registry wiring — reconciliation, ordering, clear dispatch — is what
// these assertions are about.
vi.mock('./modelPinRecords.js', () => ({ collectRecordPins: vi.fn(), clearRecordPin: vi.fn() }));

const { listProviders } = await import('./providers.js');
const { removeByMetadata } = await import('./notifications.js');
const { getSettings, updateSettingsWith } = await import('./settings.js');
const { loadSchedule, updateTaskInterval } = await import('./taskSchedule.js');
const { getActiveApps, updateAppTaskTypeOverride } = await import('./apps.js');
const { collectRecordPins, clearRecordPin } = await import('./modelPinRecords.js');
const {
  auditModelPins, clearModelPin, MODEL_OVERRIDE_CAPABLE_MODES, PINNED_IMAGE_MODE_IDS,
} = await import('./modelPinAudit.js');

// The retirement that motivated #7315: `gemini-3.5-flash-low` is gone, the
// 3.6 tiers replaced it.
const AGY = {
  id: 'antigravity-cli',
  name: 'Antigravity CLI',
  command: 'agy',
  models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-high'],
};
const CODEX = { id: 'codex', name: 'Codex', command: 'codex', models: ['gpt-5-codex'] };

const settingsWith = (overrides) => ({ imageGen: {}, renderDefaults: {}, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  listProviders.mockResolvedValue([AGY, CODEX]);
  getSettings.mockResolvedValue(settingsWith({}));
  loadSchedule.mockResolvedValue({ tasks: {} });
  getActiveApps.mockResolvedValue([]);
  removeByMetadata.mockResolvedValue({ success: true, removed: 0 });
  collectRecordPins.mockResolvedValue([]);
});

// One record's stored render pin, as the record source reports it.
const recordPin = (overrides = {}) => ({
  id: 'record:universe:u-1',
  family: 'universe',
  recordId: 'u-1',
  mode: 'agy',
  model: 'gemini-3.5-flash-low',
  label: 'Neon Dusk · universe render model',
  location: 'Universes → Render',
  href: '/universes/u-1?tab=render',
  ...overrides,
});

describe('image-gen pin coverage', () => {
  it('audits every cloud mode that can carry a model override', () => {
    // Without this, a third override-capable backend lands a capability entry
    // and is then silently un-audited — its pins would never surface.
    expect([...PINNED_IMAGE_MODE_IDS].sort()).toEqual([...MODEL_OVERRIDE_CAPABLE_MODES].sort());
  });
});

describe('auditModelPins', () => {
  it('reports a retired Settings image-gen pin with where it lives and what is offered', async () => {
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { enabled: true, model: 'gemini-3.5-flash-low' } },
    }));

    const { pins, providers } = await auditModelPins();

    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      id: 'settings:imageGen.agy.model',
      providerId: 'antigravity-cli',
      model: 'gemini-3.5-flash-low',
      location: 'Settings → Media Gen → Image Gen',
    });
    // Offered as BASE ids — the effort tier rides on `--effort`, so listing both
    // suffixed variants would read as two models to choose between.
    expect(providers['antigravity-cli'].available).toEqual(['gemini-3.6-flash']);
  });

  it('stays silent while every pin is still served', async () => {
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { model: 'gemini-3.6-flash-low' }, codex: { model: 'gpt-5-codex' } },
    }));
    await expect(auditModelPins()).resolves.toEqual({ pins: [], providers: {} });
  });

  it('ships a catalog only for the providers a stale pin actually names', async () => {
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { model: 'gemini-3.5-flash-low' }, codex: { model: 'gpt-5-codex' } },
    }));
    const { providers } = await auditModelPins();
    expect(Object.keys(providers)).toEqual(['antigravity-cli']);
  });

  it('judges a renderDefaults pin only when its own mode names a CLI provider', async () => {
    // The same field holds a local diffusion checkpoint when the surface renders
    // locally, and an entry with no mode inherits a default whose provider is
    // unknowable from here. Neither is a retirement.
    getSettings.mockResolvedValue(settingsWith({
      renderDefaults: {
        'universe-bible': { imageMode: 'agy', imageModel: 'gemini-3.5-flash-low' },
        'music-video': { imageMode: 'local', imageModel: 'flux-dev-retired' },
        deck: { imageModel: 'gemini-3.5-flash-low' },
      },
    }));
    const { pins } = await auditModelPins();
    expect(pins.map((p) => p.id)).toEqual(['settings:renderDefaults.universe-bible.imageModel']);
  });

  it('reports a scheduled-task pin against the provider the task names', async () => {
    loadSchedule.mockResolvedValue({
      tasks: {
        'code-review': { providerId: 'antigravity-cli', model: 'gemini-3.5-flash-low' },
        healthy: { providerId: 'codex', model: 'gpt-5-codex' },
        unpinned: { providerId: 'codex', model: null },
      },
    });
    const { pins } = await auditModelPins();
    expect(pins.map((p) => p.id)).toEqual(['task:code-review']);
  });

  it('falls back to the global task provider for an app override that pins only a model', async () => {
    // A per-app override OUTRANKS the global pin at spawn (#4783) but may name
    // only the model, in which case it runs on the global task's provider.
    getActiveApps.mockResolvedValue([{
      id: 'app-1',
      name: 'Example App',
      taskTypeOverrides: { 'code-review': { model: 'gemini-3.5-flash-low' } },
    }]);
    loadSchedule.mockResolvedValue({ tasks: { 'code-review': { providerId: 'antigravity-cli' } } });

    const { pins } = await auditModelPins();
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({ id: 'app:app-1:code-review', providerId: 'antigravity-cli' });
  });

  it('leaves an app override alone when no provider can be resolved for it', async () => {
    // With neither pin the task runs on the install's ACTIVE provider, which is
    // not knowable here — guessing would produce a false retirement warning.
    getActiveApps.mockResolvedValue([{
      id: 'app-1',
      name: 'Example App',
      taskTypeOverrides: { 'code-review': { model: 'gemini-3.5-flash-low' } },
    }]);
    await expect(auditModelPins()).resolves.toMatchObject({ pins: [] });
  });

  it('renders the other sections when one store cannot be read', async () => {
    getSettings.mockResolvedValue(settingsWith({ imageGen: { agy: { model: 'gemini-3.5-flash-low' } } }));
    loadSchedule.mockRejectedValue(new Error('schedule unreadable'));
    const { pins } = await auditModelPins();
    expect(pins.map((p) => p.id)).toEqual(['settings:imageGen.agy.model']);
  });
});

describe('clearModelPin', () => {
  it('removes the image-gen model key and leaves its sibling settings untouched', async () => {
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { enabled: true, agyPath: '/bin/agy', model: 'gemini-3.5-flash-low' } },
      other: 'kept',
    }));

    await expect(clearModelPin('settings:imageGen.agy.model')).resolves.toEqual({
      cleared: true, id: 'settings:imageGen.agy.model',
    });

    const next = updateSettingsWith.mock.calls[0][0](settingsWith({
      imageGen: { agy: { enabled: true, agyPath: '/bin/agy', model: 'gemini-3.5-flash-low' } },
      other: 'kept',
    }));
    // "Back to inherit" is the ABSENCE of the field — a blank string survives a
    // settings round-trip as a value the user never typed.
    expect('model' in next.imageGen.agy).toBe(false);
    expect(next.imageGen.agy).toEqual({ enabled: true, agyPath: '/bin/agy' });
    expect(next.other).toBe('kept');
  });

  it('clears a renderDefaults pin without disturbing its mode', async () => {
    getSettings.mockResolvedValue(settingsWith({
      renderDefaults: { deck: { imageMode: 'agy', imageModel: 'gemini-3.5-flash-low' } },
    }));
    await clearModelPin('settings:renderDefaults.deck.imageModel');
    const next = updateSettingsWith.mock.calls[0][0](settingsWith({
      renderDefaults: { deck: { imageMode: 'agy', imageModel: 'gemini-3.5-flash-low' } },
    }));
    expect(next.renderDefaults.deck).toEqual({ imageMode: 'agy' });
  });

  it('clears a scheduled-task pin through the schedule writer', async () => {
    loadSchedule.mockResolvedValue({ tasks: { audit: { providerId: 'codex', model: 'gpt-4o' } } });
    await clearModelPin('task:audit');
    expect(updateTaskInterval).toHaveBeenCalledWith('audit', { model: null });
  });

  it('clears a per-app override pin through the apps writer', async () => {
    getActiveApps.mockResolvedValue([{
      id: 'app-1',
      name: 'Example App',
      taskTypeOverrides: { audit: { providerId: 'codex', model: 'gpt-4o' } },
    }]);
    await clearModelPin('app:app-1:audit');
    expect(updateAppTaskTypeOverride).toHaveBeenCalledWith('app-1', 'audit', { model: null });
  });

  it('retracts the pin\'s notification card (#7332)', async () => {
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { enabled: true, model: 'gemini-3.5-flash-low' } },
    }));
    await clearModelPin('settings:imageGen.agy.model');
    expect(removeByMetadata).toHaveBeenCalledWith('pinId', 'settings:imageGen.agy.model');
  });

  it('retracts the card even for an id that names no stored pin', async () => {
    // The pin is already gone, so the card is a loop the user cannot close by
    // any other means — leaving it up is the failure, not the retraction.
    await clearModelPin('settings:imageGen.agy.model');
    expect(removeByMetadata).toHaveBeenCalledWith('pinId', 'settings:imageGen.agy.model');
  });

  it('still reports the clear when retracting the card fails', async () => {
    const errored = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { enabled: true, model: 'gemini-3.5-flash-low' } },
    }));
    removeByMetadata.mockRejectedValueOnce(new Error('notifications.json unwritable'));

    await expect(clearModelPin('settings:imageGen.agy.model')).resolves.toEqual({
      cleared: true, id: 'settings:imageGen.agy.model',
    });
    expect(errored.mock.calls[0][0]).toContain('notifications.json unwritable');
    errored.mockRestore();
  });

  it('reaches no writer for an id that names no collected pin', async () => {
    // The re-collect is a write-target ALLOWLIST, not just a freshness check:
    // the route bounds `pinId` to a string and nothing more, and
    // `updateTaskInterval` CREATES a task when absent — so a parsed id would
    // let a request mint a schedule entry. An id already cleared takes this
    // same branch and is a success with `cleared: false`, not a 404.
    await expect(clearModelPin('settings:imageGen.agy.model; DROP')).resolves.toEqual({
      cleared: false, id: 'settings:imageGen.agy.model; DROP',
    });
    expect(updateSettingsWith).not.toHaveBeenCalled();
    expect(updateTaskInterval).not.toHaveBeenCalled();
    expect(updateAppTaskTypeOverride).not.toHaveBeenCalled();
    expect(clearRecordPin).not.toHaveBeenCalled();
  });
});

describe('per-record pins (#7326)', () => {
  it('reports a retired record pin with its deep link and what the provider now offers', async () => {
    collectRecordPins.mockResolvedValue([recordPin()]);

    const { pins, providers } = await auditModelPins();

    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      id: 'record:universe:u-1',
      kind: 'record',
      model: 'gemini-3.5-flash-low',
      label: 'Neon Dusk · universe render model',
      href: '/universes/u-1?tab=render',
    });
    expect(providers['antigravity-cli'].available).toEqual(['gemini-3.6-flash']);
  });

  it.each([
    ['a local diffusion checkpoint', 'local', 'sdxl-base'],
    ['the auto sentinel', 'auto', 'gemini-3.5-flash-low'],
    ['no mode at all', null, 'gemini-3.5-flash-low'],
  ])('drops a record pin whose mode names %s — its provider is not a CLI catalog', async (_case, mode, model) => {
    // The false positive this gate exists to prevent: a working LOCAL pin
    // reported as retired, with a one-click button offering to delete it.
    collectRecordPins.mockResolvedValue([recordPin({ mode, model })]);

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('leaves a record pinned to a model the provider still lists alone', async () => {
    collectRecordPins.mockResolvedValue([recordPin({ model: 'gemini-3.6-flash-high' })]);

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('orders record pins after the install-wide ones', async () => {
    // A setting that mis-points every surface outranks one record's own choice.
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { enabled: true, model: 'gemini-3.5-flash-low' } },
    }));
    collectRecordPins.mockResolvedValue([recordPin()]);

    expect((await auditModelPins()).pins.map((pin) => pin.id))
      .toEqual(['settings:imageGen.agy.model', 'record:universe:u-1']);
  });

  it('keeps the rest of the audit when the record scan throws', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { enabled: true, model: 'gemini-3.5-flash-low' } },
    }));
    collectRecordPins.mockRejectedValue(new Error('database is down'));

    expect((await auditModelPins()).pins.map((pin) => pin.id)).toEqual(['settings:imageGen.agy.model']);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('record'));
    logged.mockRestore();
  });

  it('clears a record pin through the record writer, carrying the family it belongs to', async () => {
    collectRecordPins.mockResolvedValue([recordPin()]);

    await expect(clearModelPin('record:universe:u-1')).resolves.toEqual({
      cleared: true, id: 'record:universe:u-1',
    });
    expect(clearRecordPin).toHaveBeenCalledWith(expect.objectContaining({ family: 'universe', recordId: 'u-1' }));
    // The model field alone — nothing here may write a mode or a provider.
    expect(updateSettingsWith).not.toHaveBeenCalled();
  });
});
