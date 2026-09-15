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
vi.mock('./taskTemplates.js', () => ({ getAllTemplates: vi.fn(), updateTemplate: vi.fn() }));

const { listProviders } = await import('./providers.js');
const { removeByMetadata } = await import('./notifications.js');
const { getSettings, updateSettingsWith } = await import('./settings.js');
const { loadSchedule, updateTaskInterval } = await import('./taskSchedule.js');
const { getActiveApps, updateAppTaskTypeOverride } = await import('./apps.js');
const { collectRecordPins, clearRecordPin } = await import('./modelPinRecords.js');
const { getAllTemplates, updateTemplate } = await import('./taskTemplates.js');
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
// The reviewer union's reason to exist (#7339): one record lags the other, so a
// tier only the TUI lists is still a model the `claude` binary accepts.
const CLAUDE_CLI = { id: 'claude-code', name: 'Claude Code', command: 'claude', models: ['claude-sonnet-4-6'] };
const CLAUDE_TUI = { id: 'claude-code-tui', name: 'Claude Code TUI', command: 'claude', models: ['claude-sonnet-5'] };
const OLLAMA = { id: 'ollama', name: 'Ollama', endpoint: 'http://localhost:11434', models: ['qwen2.5:7b'] };

const settingsWith = (overrides) => ({ imageGen: {}, renderDefaults: {}, ...overrides });

beforeEach(() => {
  vi.clearAllMocks();
  listProviders.mockResolvedValue([AGY, CODEX]);
  getSettings.mockResolvedValue(settingsWith({}));
  loadSchedule.mockResolvedValue({ tasks: {} });
  getActiveApps.mockResolvedValue([]);
  removeByMetadata.mockResolvedValue({ success: true, removed: 0 });
  collectRecordPins.mockResolvedValue([]);
  getAllTemplates.mockResolvedValue([]);
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
      providerIds: ['antigravity-cli'],
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
    await expect(auditModelPins()).resolves.toEqual({ pins: [], providers: {}, incomplete: false });
  });

  it('marks the audit incomplete rather than healthy when a store read fails', async () => {
    // An unevaluated pin set must not read as "nothing stale": the notifier
    // retracts on empty, so a transient read error would withdraw announced
    // cards and re-notify on the next audit.
    loadSchedule.mockRejectedValueOnce(new Error('schedule unreadable'));
    await expect(auditModelPins()).resolves.toEqual({ pins: [], providers: {}, incomplete: true });
  });

  it('marks the audit incomplete when a collector throws', async () => {
    getActiveApps.mockRejectedValueOnce(new Error('apps store unreadable'));
    const result = await auditModelPins();
    expect(result.incomplete).toBe(true);
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
    expect(pins[0]).toMatchObject({ id: 'app:app-1:code-review', providerIds: ['antigravity-cli'] });
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

  it('writes nothing into settings for a path whose parent is not there', async () => {
    // The shared settings writer copies every level above the key it removes —
    // it must not MINT one. Building `{ codeReview: {} }` for a pin that is
    // already gone is a settings change the user never asked for.
    getSettings.mockResolvedValue(settingsWith({ codeReview: { codexModel: 'gpt-4o' } }));
    await clearModelPin('settings:codeReview.codexModel');
    const next = updateSettingsWith.mock.calls[0][0](settingsWith({}));
    expect(next.imageGen).toEqual({});
    expect('codeReview' in next).toBe(false);
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
    expect(updateTemplate).not.toHaveBeenCalled();
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

describe('reviewer model pins (#7339)', () => {
  const codeReview = (overrides) => settingsWith({ codeReview: overrides });

  it('reports a retired reviewer pin with its deep link and what the provider now offers', async () => {
    getSettings.mockResolvedValue(codeReview({ codexModel: 'gpt-4o' }));

    const { pins, providers } = await auditModelPins();

    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      id: 'settings:codeReview.codexModel',
      kind: 'reviewerModel',
      model: 'gpt-4o',
      providerIds: ['codex'],
      location: 'Code Review Defaults',
      href: '/models/code-reviewers',
    });
    expect(providers.codex.available).toEqual(['gpt-5-codex']);
  });

  it('leaves a claude pin alone when only the TUI record lists it', async () => {
    // THE regression the union exists for. `claude` names a BINARY; judging its
    // pin against `claude-code` alone would call a tier retired that the TUI
    // record still lists — and the picker would go on offering it.
    listProviders.mockResolvedValue([CLAUDE_CLI, CLAUDE_TUI]);
    getSettings.mockResolvedValue(codeReview({ claudeModel: 'claude-sonnet-5' }));

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('reports a claude pin no record fronting the binary lists, naming both catalogs', async () => {
    listProviders.mockResolvedValue([CLAUDE_CLI, CLAUDE_TUI]);
    getSettings.mockResolvedValue(codeReview({ claudeModel: 'claude-3-opus' }));

    const { pins, providers } = await auditModelPins();

    expect(pins[0]).toMatchObject({
      id: 'settings:codeReview.claudeModel',
      providerIds: ['claude-code', 'claude-code-tui'],
    });
    // Both catalogs ride along so the panel can union them — one record's list
    // would hide half of what the reviewer can actually be handed.
    expect(Object.keys(providers).sort()).toEqual(['claude-code', 'claude-code-tui']);
  });

  it('leaves a local-daemon reviewer pin alone — the daemon is the authority', async () => {
    // `lmstudio`/`ollama` records carry a cached snapshot, not a catalog. The
    // carve-out in modelPinMembership.js is what keeps a freshly pulled model
    // from being reported as retired.
    listProviders.mockResolvedValue([OLLAMA]);
    getSettings.mockResolvedValue(codeReview({ ollamaModel: 'llama3.3:70b' }));

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('leaves a reviewer pin alone when no record on this install fronts its binary', async () => {
    // Nothing to judge it against — guessing a catalog is how a false
    // retirement gets in front of the user.
    listProviders.mockResolvedValue([CODEX]);
    getSettings.mockResolvedValue(codeReview({ cursorModel: 'gpt-5-retired' }));

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('ignores a hand-edited pin the token builders would drop anyway', async () => {
    // `settings.json` is hand-editable; a `[`-bearing id never reaches a
    // reviewer, so warning that it is retired points at the wrong problem.
    getSettings.mockResolvedValue(codeReview({ codexModel: 'gpt-4o[bogus]' }));

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('audits a provider:<id> reviewer pin against that record', async () => {
    // `providerModels` is the other half of the pin vocabulary
    // (`reviewerModelsFromDefaults` folds both), and a `provider:<id>` token
    // names its record outright — no matcher union needed.
    getSettings.mockResolvedValue(codeReview({ providerModels: { 'provider:codex': 'gpt-4o' } }));

    const { pins } = await auditModelPins();

    expect(pins[0]).toMatchObject({
      id: 'settings:codeReview.providerModels.provider:codex',
      providerIds: ['codex'],
      model: 'gpt-4o',
    });
  });

  it('clears a provider:<id> pin out of the providerModels map, leaving its siblings', async () => {
    const stored = codeReview({ providerModels: { 'provider:codex': 'gpt-4o', 'provider:other': 'keep-me' } });
    getSettings.mockResolvedValue(stored);

    await clearModelPin('settings:codeReview.providerModels.provider:codex');

    const next = updateSettingsWith.mock.calls[0][0](stored);
    expect(next.codeReview.providerModels).toEqual({ 'provider:other': 'keep-me' });
  });

  it('ignores the goal-fidelity model while the gate is switched off', async () => {
    // `resolveGoalFidelityConfig` owns when the gate runs at all; a pin no run
    // would carry is not one to warn about — and its id must reach no writer.
    listProviders.mockResolvedValue([CODEX]);
    getSettings.mockResolvedValue(codeReview({
      goalFidelity: { enabled: false, backend: 'ollama', model: 'gpt-4o' },
    }));

    expect((await auditModelPins()).pins).toEqual([]);
    await expect(clearModelPin('settings:codeReview.goalFidelity.model'))
      .resolves.toMatchObject({ cleared: false });
  });

  it('clears the reviewer scalar and nothing beside it', async () => {
    const stored = codeReview({
      codexModel: 'gpt-4o',
      codexEffort: 'high',
      claudeModel: 'claude-sonnet-4-6',
      reviewers: ['codex', 'claude'],
    });
    getSettings.mockResolvedValue(stored);

    await expect(clearModelPin('settings:codeReview.codexModel')).resolves.toEqual({
      cleared: true, id: 'settings:codeReview.codexModel',
    });

    const next = updateSettingsWith.mock.calls[0][0](stored);
    expect('codexModel' in next.codeReview).toBe(false);
    // Dropping the reviewer's effort, or the reviewer itself, would silently
    // weaken the review loop over a model id the user asked to forget.
    expect(next.codeReview.codexEffort).toBe('high');
    expect(next.codeReview.claudeModel).toBe('claude-sonnet-4-6');
    expect(next.codeReview.reviewers).toEqual(['codex', 'claude']);
  });

  it('clears the goal-fidelity model without disturbing its backend or effort', async () => {
    listProviders.mockResolvedValue([{ id: 'lmstudio', name: 'LM Studio' }]);
    const stored = codeReview({
      goalFidelity: { enabled: true, backend: 'lmstudio', model: 'gpt-4o', effort: 'high' },
    });
    getSettings.mockResolvedValue(stored);

    await clearModelPin('settings:codeReview.goalFidelity.model');

    const next = updateSettingsWith.mock.calls[0][0](stored);
    expect(next.codeReview.goalFidelity).toEqual({ enabled: true, backend: 'lmstudio', effort: 'high' });
  });
});

describe('task template pins (#7339)', () => {
  const template = (overrides = {}) => ({
    id: 'user-abc',
    name: 'Nightly sweep',
    provider: 'codex',
    model: 'gpt-4o',
    ...overrides,
  });

  it('reports a retired template pin with its name and where it is picked', async () => {
    getAllTemplates.mockResolvedValue([template()]);

    const { pins } = await auditModelPins();

    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      id: 'template:user-abc',
      kind: 'taskTemplate',
      templateId: 'user-abc',
      providerIds: ['codex'],
      model: 'gpt-4o',
      label: 'Nightly sweep · template model',
      location: 'Chief of Staff → Tasks → Quick Templates',
      href: '/cos/tasks',
    });
  });

  it.each([
    ['a template that pins no provider', { provider: '' }],
    ['a built-in, which pins neither field', { provider: undefined, model: undefined }],
    ['a template still on a listed model', { model: 'gpt-5-codex' }],
  ])('leaves %s alone', async (_case, overrides) => {
    getAllTemplates.mockResolvedValue([template(overrides)]);

    expect((await auditModelPins()).pins).toEqual([]);
  });

  it('clears the template model through the templates writer, leaving its provider pinned', async () => {
    getAllTemplates.mockResolvedValue([template()]);

    await expect(clearModelPin('template:user-abc')).resolves.toEqual({
      cleared: true, id: 'template:user-abc',
    });
    // `''` is this store's own unpinned encoding, and `updateTemplate` MERGES —
    // an absent key would leave the retired id exactly where it was.
    expect(updateTemplate).toHaveBeenCalledWith('user-abc', { model: '' });
  });

  it('keeps the rest of the audit when the templates store cannot be read', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    getSettings.mockResolvedValue(settingsWith({
      imageGen: { agy: { model: 'gemini-3.5-flash-low' } },
    }));
    getAllTemplates.mockRejectedValue(new Error('task-templates.json unreadable'));

    expect((await auditModelPins()).pins.map((pin) => pin.id)).toEqual(['settings:imageGen.agy.model']);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('taskTemplate'));
    logged.mockRestore();
  });
});
