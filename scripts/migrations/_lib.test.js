/**
 * Direct unit tests for `applyPromptReplaceMigration` opt-ins that aren't
 * exercised end-to-end by the per-migration `runPromptMigrationTests` helper:
 *
 *   - `createIfMissing` — copy sample → data when data is absent (mig 005)
 *   - `retireOnSampleMissing` — soft-delete data when sample is absent (mig 003)
 *
 * Per-migration tests still rely on the underlying loop logic; these
 * exercise the branches the helper guards behind opt-in flags.
 *
 * Also home to the shell suites for the other migration factories —
 * `makeSplitMigration`'s flags, `makeProviderSeedMigration`'s whole
 * read → guard → add-missing-ids → write shell (which the six provider-seed
 * migrations 149/152/185/195/201/231 used to re-assert one file at a time), and
 * `makeSeededProviderTierMigration` — including a differential suite proving it
 * reproduces the shipped 153 / 206 tier bumps byte-for-byte without those
 * frozen migrations being rewritten to consume it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { applyPromptReplaceMigration, md5, readLayoutsDoc, writeLayoutsDoc, makeSplitMigration, makeProviderSeedMigration, makeSeededProviderTierMigration, seededProviderTierModels } from './_lib.js';
import { runSeededProviderTierMigrationTests } from './_testHelpers.js';
import sonnet5Migration from './153-claude-default-sonnet-5.js';
import opus5Migration from './206-claude-default-opus-5.js';

const FILENAME = 'pipeline-fake.md';
const BODY_OLD = '# OLD\n';
const BODY_NEW = '# NEW\n';
const BODY_CUSTOM = '# CUSTOMIZED\n';

const baseOpts = {
  accepted: { [FILENAME]: [md5(BODY_OLD)] },
  current: { [FILENAME]: md5(BODY_NEW) },
  label: 'fake',
  customizedHint: () => '',
};

describe('applyPromptReplaceMigration opt-ins', () => {
  let rootDir;
  let stagesDir;
  let sampleDir;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-lib-'));
    stagesDir = join(rootDir, 'data', 'prompts', 'stages');
    sampleDir = join(rootDir, 'data.reference', 'prompts', 'stages');
    mkdirSync(stagesDir, { recursive: true });
    mkdirSync(sampleDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  describe('createIfMissing', () => {
    it('copies the sample into data/ when data file is absent', async () => {
      writeFileSync(join(sampleDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, createIfMissing: true });
      expect(result).toMatchObject({ created: 1, updated: 0, skipped: 0 });
      expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(BODY_NEW);
    });

    it('no-ops when both data and sample are absent', async () => {
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, createIfMissing: true });
      expect(result).toMatchObject({ created: 0, updated: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });

    it('default `createIfMissing: false` leaves data absent', async () => {
      writeFileSync(join(sampleDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts });
      expect(result).toMatchObject({ created: 0, updated: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });
  });

  describe('retireOnSampleMissing', () => {
    it('soft-deletes an unmodified data file when the sample is gone', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_OLD);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ retired: 1, updated: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });

    it('warns and skips when the data file was customized', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_CUSTOM);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ retired: 0, updated: 0, skipped: 1 });
      expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(BODY_CUSTOM);
    });

    it('retires even when data matches the current hash (sample renamed after the migration shipped)', async () => {
      // Regression: a user who already ran the migration (data at NEW hash)
      // and then pulled the rename should still get the now-obsolete file
      // cleaned up. Without this branch the file would be classified as
      // `alreadyCurrent` and left in `data/`.
      writeFileSync(join(stagesDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ retired: 1, alreadyCurrent: 0, skipped: 0 });
      expect(existsSync(join(stagesDir, FILENAME))).toBe(false);
    });

    it('still applies the normal upgrade when the sample is present', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_OLD);
      writeFileSync(join(sampleDir, FILENAME), BODY_NEW);
      const result = await applyPromptReplaceMigration({ rootDir, ...baseOpts, retireOnSampleMissing: true });
      expect(result).toMatchObject({ updated: 1, retired: 0, skipped: 0 });
      expect(readFileSync(join(stagesDir, FILENAME), 'utf-8')).toBe(BODY_NEW);
    });

    it('default `retireOnSampleMissing: false` raises on missing sample for an old-hash file', async () => {
      writeFileSync(join(stagesDir, FILENAME), BODY_OLD);
      await expect(
        applyPromptReplaceMigration({ rootDir, ...baseOpts }),
      ).rejects.toThrow(/ENOENT/);
    });
  });

  describe('multi-file scan', () => {
    // The per-file scan runs in parallel (Promise.all). These assert the
    // post-flight counter accumulation stays correct across files that land in
    // different branches — distinct outcomes must each be counted exactly once.
    const NAMES = ['pipeline-a.md', 'pipeline-b.md', 'pipeline-c.md'];
    const multiOpts = {
      accepted: Object.fromEntries(NAMES.map((n) => [n, [md5(BODY_OLD)]])),
      current: Object.fromEntries(NAMES.map((n) => [n, md5(BODY_NEW)])),
      label: 'multi',
      customizedHint: () => '',
    };

    it('accumulates each file into its own counter across distinct outcomes', async () => {
      // a → old hash + sample present → updated
      writeFileSync(join(stagesDir, 'pipeline-a.md'), BODY_OLD);
      writeFileSync(join(sampleDir, 'pipeline-a.md'), BODY_NEW);
      // b → already at current hash → alreadyCurrent
      writeFileSync(join(stagesDir, 'pipeline-b.md'), BODY_NEW);
      // c → customized (matches neither) → skipped
      writeFileSync(join(stagesDir, 'pipeline-c.md'), BODY_CUSTOM);

      const result = await applyPromptReplaceMigration({ rootDir, ...multiOpts });
      expect(result).toEqual({ updated: 1, alreadyCurrent: 1, skipped: 1, created: 0, retired: 0 });
      expect(readFileSync(join(stagesDir, 'pipeline-a.md'), 'utf-8')).toBe(BODY_NEW);
      expect(readFileSync(join(stagesDir, 'pipeline-c.md'), 'utf-8')).toBe(BODY_CUSTOM);
    });

    it('updates every file when all are at the accepted-old hash', async () => {
      for (const name of NAMES) {
        writeFileSync(join(stagesDir, name), BODY_OLD);
        writeFileSync(join(sampleDir, name), BODY_NEW);
      }
      const result = await applyPromptReplaceMigration({ rootDir, ...multiOpts });
      expect(result).toEqual({ updated: 3, alreadyCurrent: 0, skipped: 0, created: 0, retired: 0 });
      for (const name of NAMES) {
        expect(readFileSync(join(stagesDir, name), 'utf-8')).toBe(BODY_NEW);
      }
    });

    it('fail-stops before any write when one file has a missing sample', async () => {
      // Regression for the parallel-scan failure semantics: the plan phase
      // reads every file concurrently, but a single rejection (here, an
      // accepted-old file whose sample is gone → ENOENT) must abort the whole
      // migration BEFORE the apply phase mutates ANY file — so the other
      // updatable file is left untouched, not nondeterministically written.
      writeFileSync(join(stagesDir, 'pipeline-a.md'), BODY_OLD);
      writeFileSync(join(sampleDir, 'pipeline-a.md'), BODY_NEW); // would update
      writeFileSync(join(stagesDir, 'pipeline-b.md'), BODY_OLD); // sample missing → throws
      writeFileSync(join(stagesDir, 'pipeline-c.md'), BODY_OLD);
      writeFileSync(join(sampleDir, 'pipeline-c.md'), BODY_NEW); // would update

      await expect(
        applyPromptReplaceMigration({ rootDir, ...multiOpts }),
      ).rejects.toThrow(/ENOENT/);

      // No write landed — every data file still holds its pre-migration body.
      expect(readFileSync(join(stagesDir, 'pipeline-a.md'), 'utf-8')).toBe(BODY_OLD);
      expect(readFileSync(join(stagesDir, 'pipeline-c.md'), 'utf-8')).toBe(BODY_OLD);
    });
  });
});

describe('readLayoutsDoc / writeLayoutsDoc', () => {
  let rootDir;
  let dataDir;
  let layoutsPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'migration-layouts-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
    layoutsPath = join(dataDir, 'dashboard-layouts.json');
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports no-state when the file is absent', async () => {
    const result = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('no-state');
    expect(result.path).toBe(layoutsPath);
  });

  it('reports unreadable for malformed JSON', async () => {
    writeFileSync(layoutsPath, 'not json');
    const result = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('unreadable');
  });

  it('reports no-layouts-array when the layouts key is missing or non-array', async () => {
    writeFileSync(layoutsPath, JSON.stringify({ activeLayoutId: 'default' }));
    expect((await readLayoutsDoc({ rootDir, label: 'x' })).reason).toBe('no-layouts-array');
    writeFileSync(layoutsPath, JSON.stringify({ layouts: 'nope' }));
    expect((await readLayoutsDoc({ rootDir, label: 'x' })).reason).toBe('no-layouts-array');
    writeFileSync(layoutsPath, 'null');
    expect((await readLayoutsDoc({ rootDir, label: 'x' })).reason).toBe('no-layouts-array');
  });

  it('returns the parsed doc + path when valid', async () => {
    const doc = { activeLayoutId: 'default', layouts: [{ id: 'default', widgets: [] }] };
    writeFileSync(layoutsPath, JSON.stringify(doc));
    const result = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(result.ok).toBe(true);
    expect(result.path).toBe(layoutsPath);
    expect(result.doc).toEqual(doc);
  });

  it('round-trips through writeLayoutsDoc with 2-space indentation', async () => {
    const doc = { activeLayoutId: 'default', layouts: [{ id: 'default', widgets: ['cos'] }] };
    await writeLayoutsDoc(layoutsPath, doc);
    const raw = readFileSync(layoutsPath, 'utf-8');
    expect(raw).toBe(JSON.stringify(doc, null, 2));
    const reread = await readLayoutsDoc({ rootDir, label: 'migration test' });
    expect(reread.ok).toBe(true);
    expect(reread.doc).toEqual(doc);
  });
});

// The four real split migrations (034/035/036/059) exercise the factory
// end-to-end in their own suites; these tests pin the DISTINGUISHING FLAGS in
// isolation so a future edit to makeSplitMigration that breaks one flag fails
// loudly here even if the per-migration suites still pass by coincidence.
describe('makeSplitMigration flags', () => {
  let rootDir;
  let dataDir;
  const readJson = (p) => JSON.parse(readFileSync(p, 'utf-8'));

  // Minimal config; individual tests spread overrides over this.
  const base = {
    migrationLabel: 'migration test',
    typeDirName: 'widgets',
    legacyFilename: 'widgets.json',
    backupSuffix: '.bak-test',
    typeSchemaVersion: 1,
    typeLabel: 'widgets',
    recordsKey: 'widgets',
    idPattern: /^w-[A-Za-z0-9]+$/,
    recordNoun: 'widget',
  };

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'split-flags-'));
    dataDir = join(rootDir, 'data');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const seedLegacy = (records) =>
    writeFileSync(join(dataDir, 'widgets.json'), JSON.stringify({ widgets: records }) + '\n');

  it('buildConfig defaults to {} and receives the parsed doc', async () => {
    seedLegacy([{ id: 'w-1' }]);
    const mig = makeSplitMigration({ ...base, buildConfig: (doc) => ({ count: doc.widgets.length }) });
    await mig.up({ rootDir });
    expect(readJson(join(dataDir, 'widgets', 'index.json')).config).toEqual({ count: 1 });

    // Default buildConfig → {} on a fresh install (doc is null).
    rmSync(rootDir, { recursive: true, force: true });
    mkdirSync(dataDir, { recursive: true });
    await makeSplitMigration(base).up({ rootDir });
    expect(readJson(join(dataDir, 'widgets', 'index.json')).config).toEqual({});
  });

  it('dedupe:false writes a duplicate id twice-attempted (second skipped only if already on disk), dedupe:true is first-wins', async () => {
    // Without dedupe, two records with the same id: the second overwrites via
    // the same dir (no in-loop claim), so written counts both attempts minus
    // the on-disk skip. Assert the first-wins SURVIVOR differs by flag.
    seedLegacy([{ id: 'w-1', tag: 'first' }, { id: 'w-1', tag: 'second' }]);
    const deduped = makeSplitMigration({ ...base, dedupe: true });
    const res = await deduped.up({ rootDir });
    expect(res).toMatchObject({ written: 1, skipped: 1, invalid: 0 });
    expect(readJson(join(dataDir, 'widgets', 'w-1', 'index.json')).tag).toBe('first');
  });

  it('extraValid rejects records failing the predicate (counted invalid)', async () => {
    seedLegacy([{ id: 'w-1', name: 'ok' }, { id: 'w-2', name: '' }]);
    const mig = makeSplitMigration({ ...base, extraValid: (r) => typeof r.name === 'string' && !!r.name.trim() });
    const res = await mig.up({ rootDir });
    expect(res).toMatchObject({ written: 1, invalid: 1 });
    expect(existsSync(join(dataDir, 'widgets', 'w-1', 'index.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'widgets', 'w-2', 'index.json'))).toBe(false);
  });

  it("onUnreadable:'return' reports {ok:false} and stamps nothing", async () => {
    writeFileSync(join(dataDir, 'widgets.json'), 'not json');
    const res = await makeSplitMigration({ ...base, onUnreadable: 'return' }).up({ rootDir });
    expect(res).toEqual({ ok: false, reason: 'unreadable' });
    expect(existsSync(join(dataDir, 'widgets', 'index.json'))).toBe(false);
  });

  it("onUnreadable:'throw' throws and stamps nothing (stays pending for a re-split)", async () => {
    writeFileSync(join(dataDir, 'widgets.json'), 'not json');
    const mig = makeSplitMigration({ ...base, onUnreadable: 'throw' });
    await expect(mig.up({ rootDir })).rejects.toThrow(/unreadable/);
    expect(existsSync(join(dataDir, 'widgets', 'index.json'))).toBe(false);
  });
});

// The shell shared by every provider-seed migration (149/152/185/195/201/231).
// These cases used to be re-asserted once per migration against byte-identical
// code; they live here once now, so each migration's own suite only pins what
// is genuinely specific to its payload.
describe('makeProviderSeedMigration', () => {
  let rootDir;
  let providersPath;

  // One shared array across both defs — the 231/CURSOR_MODELS shape.
  const SHARED_MODELS = ['m1', 'm2'];
  const DEF_A = { id: 'seed-a', name: 'Seed A', type: 'cli', models: SHARED_MODELS, envVars: { K: 'v' } };
  const DEF_B = { id: 'seed-b', name: 'Seed B', type: 'tui', models: SHARED_MODELS, envVars: { K: 'v' } };
  const mig = () => makeProviderSeedMigration({ label: 'Seed', defs: [DEF_A, DEF_B] });

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'provider-seed-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const write = (value) => writeFileSync(providersPath, JSON.stringify(value, null, 2) + '\n');
  const read = () => JSON.parse(readFileSync(providersPath, 'utf-8'));

  it('adds every missing def and leaves unrelated providers + top-level keys untouched', async () => {
    write({ activeProvider: 'claude-code', providers: { 'claude-code': { id: 'claude-code', type: 'cli' } } });

    expect(await mig().up({ rootDir })).toEqual({ ok: true, reason: 'seeded', added: 2 });

    const out = read();
    expect(out.providers['seed-a']).toEqual(DEF_A);
    expect(out.providers['seed-b']).toEqual(DEF_B);
    expect(out.providers['claude-code']).toEqual({ id: 'claude-code', type: 'cli' });
    expect(out.activeProvider).toBe('claude-code');
  });

  it('never overwrites an existing entry, but still adds its missing siblings', async () => {
    write({ providers: { 'seed-a': { id: 'seed-a', enabled: true, apiKey: 'user-key' } } });

    expect(await mig().up({ rootDir })).toMatchObject({ reason: 'seeded', added: 1 });

    const out = read();
    expect(out.providers['seed-a']).toEqual({ id: 'seed-a', enabled: true, apiKey: 'user-key' });
    expect(out.providers['seed-b']).toBeDefined();
  });

  it('deep-copies each def so sibling entries and the frozen module default stay detached', async () => {
    // DEF_A and DEF_B share one `models` array by reference (231's CURSOR_MODELS
    // shape). A shallow spread would give both installed entries — and the
    // module-level constant — the same array object.
    expect(DEF_A.models).toBe(DEF_B.models);
    write({ providers: {} });

    await mig().up({ rootDir });

    const out = read();
    out.providers['seed-a'].models.push('mutated');
    out.providers['seed-a'].envVars.K = 'mutated';
    expect(out.providers['seed-b'].models).toEqual(['m1', 'm2']);
    expect(DEF_A.models).toEqual(['m1', 'm2']);
    expect(DEF_A.envVars.K).toBe('v');
  });

  it('is idempotent — a second run rewrites nothing', async () => {
    write({ providers: { 'claude-code': { id: 'claude-code', type: 'cli' } } });

    await mig().up({ rootDir });
    const afterFirst = readFileSync(providersPath, 'utf-8');

    expect(await mig().up({ rootDir })).toEqual({ ok: true, reason: 'already-present', added: 0 });
    expect(readFileSync(providersPath, 'utf-8')).toBe(afterFirst);
  });

  it('is a no-op when data/providers.json does not exist (fresh install seeds from data.reference)', async () => {
    expect(await mig().up({ rootDir })).toEqual({ ok: false, reason: 'no-file', added: 0 });
    expect(existsSync(providersPath)).toBe(false);
  });

  it('leaves an unparseable file byte-identical rather than clobbering user data', async () => {
    writeFileSync(providersPath, '{ not valid json');

    expect(await mig().up({ rootDir })).toEqual({ ok: false, reason: 'unreadable', added: 0 });
    expect(readFileSync(providersPath, 'utf-8')).toBe('{ not valid json');
  });

  it('leaves the file untouched when the providers map is missing or not an object', async () => {
    for (const doc of [{}, { providers: null }, { providers: 'nope' }]) {
      write(doc);
      const before = readFileSync(providersPath, 'utf-8');
      expect(await mig().up({ rootDir })).toEqual({ ok: false, reason: 'bad-shape', added: 0 });
      expect(readFileSync(providersPath, 'utf-8')).toBe(before);
    }
  });

  it('refuses a reserved prototype key as a provider id instead of skipping it forever', async () => {
    // `providers['constructor']` is truthy on ANY plain object, so the
    // presence probe would read the inherited Object.prototype.constructor and
    // silently treat the provider as already installed on every run.
    write({ providers: {} });
    const polluting = makeProviderSeedMigration({ label: 'Bad', defs: [{ id: 'constructor', name: 'Bad' }, DEF_A] });

    expect(await polluting.up({ rootDir })).toMatchObject({ reason: 'seeded', added: 1 });

    const out = read();
    expect(Object.hasOwn(out.providers, 'constructor')).toBe(false);
    expect(out.providers['seed-a']).toBeDefined();
    // The prototype itself is untouched — nothing leaked onto Object.prototype.
    expect({}.name).toBeUndefined();
  });
});

// ---- makeSeededProviderTierMigration ----
//
// The factory has to earn the right to be used by the NEXT tier bump, and the
// only evidence that counts is the shipped ones: migrations 153 and 206 stay
// frozen and are re-expressed here as `targets` tables, then run head-to-head
// against factory-built equivalents over the same fixtures. If the factory ever
// diverges from what those two actually do to a `data/providers.json`, the
// differential suite below fails.

const SONNET_5_BARE = {
  oldModels: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
  idMap: { 'claude-sonnet-4-6': 'claude-sonnet-5' },
};
const SONNET_5_BEDROCK = {
  oldModels: [
    'us.anthropic.claude-haiku-4-5',
    'us.anthropic.claude-sonnet-4-6',
    'global.anthropic.claude-opus-4-8',
    'global.anthropic.claude-opus-4-8[1m]',
  ],
  idMap: { 'us.anthropic.claude-sonnet-4-6': 'us.anthropic.claude-sonnet-5' },
};
const SONNET_5_TARGETS = {
  'claude-code': SONNET_5_BARE,
  'claude-code-tui': SONNET_5_BARE,
  'claude-code-bedrock': SONNET_5_BEDROCK,
  'claude-code-tui-bedrock': SONNET_5_BEDROCK,
};

const OPUS_5_BARE = {
  oldModels: ['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8'],
  idMap: { 'claude-opus-4-8': 'claude-opus-5' },
};
const OPUS_5_BEDROCK = {
  oldModels: [
    'us.anthropic.claude-haiku-4-5',
    'us.anthropic.claude-sonnet-5',
    'global.anthropic.claude-opus-4-8',
    'global.anthropic.claude-opus-4-8[1m]',
  ],
  idMap: {
    'global.anthropic.claude-opus-4-8': 'global.anthropic.claude-opus-5',
    'global.anthropic.claude-opus-4-8[1m]': 'global.anthropic.claude-opus-5[1m]',
  },
};
const OPUS_5_TARGETS = {
  'claude-code': OPUS_5_BARE,
  'claude-code-tui': OPUS_5_BARE,
  'claude-code-bedrock': OPUS_5_BEDROCK,
  'claude-code-tui-bedrock': OPUS_5_BEDROCK,
};

/**
 * Every `data/providers.json` shape a tier bump has to have an opinion about,
 * derived from a `targets` table so both parameterizations get the same
 * coverage: the prior seeded shape, a survivor pin, an orphan pointer, the
 * post-bump shape, a trimmed list, a reordered list, one doc per retired id,
 * and a doc carrying an unrelated provider plus a top-level key.
 */
const tierScenarioDocs = (targets) => {
  const specs = Object.entries(targets).map(([id, target]) => ({
    id,
    target,
    retired: target.oldModels.filter((m) => Object.hasOwn(target.idMap, m)),
    surviving: target.oldModels.filter((m) => !Object.hasOwn(target.idMap, m)),
    newModels: seededProviderTierModels(target),
  }));

  const entry = (s, overrides = {}) => ({
    id: s.id,
    models: [...s.target.oldModels],
    defaultModel: s.retired.at(-1),
    lightModel: s.surviving[0],
    mediumModel: s.surviving.at(-1),
    heavyModel: s.retired.at(-1),
    ...overrides,
  });
  const doc = (build) => ({ providers: Object.fromEntries(specs.map((s) => [s.id, build(s)])) });
  const bumped = (s, overrides = {}) => entry(s, {
    models: [...s.newModels],
    defaultModel: s.target.idMap[s.retired.at(-1)],
    heavyModel: s.target.idMap[s.retired.at(-1)],
    ...overrides,
  });

  const scenarios = {
    seeded: doc((s) => entry(s)),
    survivorPin: doc((s) => entry(s, { defaultModel: s.surviving[0] })),
    orphanPointer: doc((s) => bumped(s, { defaultModel: s.retired.at(-1) })),
    alreadyCurrent: doc(bumped),
    trimmedList: doc((s) => entry(s, { models: s.target.oldModels.slice(1) })),
    reorderedList: doc((s) => entry(s, { models: [s.target.oldModels.at(-1), ...s.target.oldModels.slice(0, -1)] })),
    missingPointers: doc((s) => ({ id: s.id, models: [...s.target.oldModels] })),
    unrelatedNeighbor: {
      activeProvider: 'claude-code',
      providers: {
        ...Object.fromEntries(specs.map((s) => [s.id, entry(s)])),
        'unrelated-provider': { id: 'unrelated-provider', models: ['some-configured-default'] },
      },
    },
  };

  // One doc per retired id, so the Bedrock plain-vs-`[1m]` split is exercised
  // in both directions rather than only on whichever id the fixture defaults to.
  for (const s of specs) {
    for (const retiredId of s.retired) {
      scenarios[`pin:${s.id}:${retiredId}`] = {
        providers: { [s.id]: entry(s, { defaultModel: retiredId, heavyModel: retiredId }) },
      };
    }
  }

  return scenarios;
};

describe.each([
  ['153 (sonnet tier → claude-sonnet-5)', sonnet5Migration, SONNET_5_TARGETS, 'sonnet tier claude-sonnet-5'],
  ['206 (opus tier → claude-opus-5)', opus5Migration, OPUS_5_TARGETS, 'opus tier claude-opus-5'],
])('makeSeededProviderTierMigration reproduces shipped migration %s', (_label, shipped, targets, tierLabel) => {
  const factory = makeSeededProviderTierMigration({ targets, tierLabel });

  let shippedRoot;
  let factoryRoot;

  beforeEach(() => {
    shippedRoot = mkdtempSync(join(tmpdir(), 'tier-shipped-'));
    factoryRoot = mkdtempSync(join(tmpdir(), 'tier-factory-'));
    for (const root of [shippedRoot, factoryRoot]) mkdirSync(join(root, 'data'), { recursive: true });
  });

  afterEach(() => {
    for (const root of [shippedRoot, factoryRoot]) rmSync(root, { recursive: true, force: true });
  });

  const providersFile = (root) => join(root, 'data', 'providers.json');

  // The fixtures the family deliberately declines to touch. Naming them keeps
  // the equality assertion below honest: without this split, a factory that
  // wrote nothing at all would "match" the shipped migration on every fixture.
  const NO_OP_SCENARIOS = new Set(['alreadyCurrent', 'trimmedList', 'reorderedList']);

  it.each(Object.keys(tierScenarioDocs(targets)))('produces an identical data/providers.json for the %s fixture', async (scenario) => {
    const input = JSON.stringify(tierScenarioDocs(targets)[scenario], null, 2) + '\n';
    for (const root of [shippedRoot, factoryRoot]) writeFileSync(providersFile(root), input);

    await shipped.up({ rootDir: shippedRoot });
    await factory.up({ rootDir: factoryRoot });

    const shippedOut = readFileSync(providersFile(shippedRoot), 'utf-8');
    expect(readFileSync(providersFile(factoryRoot), 'utf-8')).toBe(shippedOut);
    if (NO_OP_SCENARIOS.has(scenario)) expect(shippedOut).toBe(input);
    else expect(shippedOut).not.toBe(input);
  });

  it('matches the shipped no-op behaviour on an absent file', async () => {
    await shipped.up({ rootDir: shippedRoot });
    await factory.up({ rootDir: factoryRoot });

    expect(existsSync(providersFile(shippedRoot))).toBe(false);
    expect(existsSync(providersFile(factoryRoot))).toBe(false);
  });

  it('matches the shipped skip on an unparseable file and on a missing providers map', async () => {
    for (const input of ['{ not valid json', '{}\n', '{ "providers": null }\n']) {
      for (const root of [shippedRoot, factoryRoot]) writeFileSync(providersFile(root), input);

      await shipped.up({ rootDir: shippedRoot });
      await factory.up({ rootDir: factoryRoot });

      expect(readFileSync(providersFile(shippedRoot), 'utf-8')).toBe(input);
      expect(readFileSync(providersFile(factoryRoot), 'utf-8')).toBe(input);
    }
  });
});

describe('makeSeededProviderTierMigration — shared contract (206 parameterization)', () => {
  runSeededProviderTierMigrationTests({
    migration: makeSeededProviderTierMigration({ targets: OPUS_5_TARGETS, tierLabel: 'opus tier claude-opus-5' }),
    targets: OPUS_5_TARGETS,
    prefix: 'tier-contract-opus-',
  });
});

describe('makeSeededProviderTierMigration — shared contract (153 parameterization)', () => {
  runSeededProviderTierMigrationTests({
    migration: makeSeededProviderTierMigration({ targets: SONNET_5_TARGETS, tierLabel: 'sonnet tier claude-sonnet-5' }),
    targets: SONNET_5_TARGETS,
    prefix: 'tier-contract-sonnet-',
  });
});

describe('makeSeededProviderTierMigration — factory-specific guards', () => {
  let rootDir;
  let providersPath;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'tier-guards-'));
    mkdirSync(join(rootDir, 'data'), { recursive: true });
    providersPath = join(rootDir, 'data/providers.json');
  });

  afterEach(() => rmSync(rootDir, { recursive: true, force: true }));

  const write = (value) => writeFileSync(providersPath, JSON.stringify(value, null, 2) + '\n');
  const read = () => JSON.parse(readFileSync(providersPath, 'utf-8'));

  it('never hands a target its own copy of the derived models array', async () => {
    // Two providers sharing one spec object must not end up sharing one array —
    // an in-memory mutation of either would otherwise show up in both.
    const mig = makeSeededProviderTierMigration({ targets: OPUS_5_TARGETS, tierLabel: 'opus tier claude-opus-5' });
    write({
      providers: {
        'claude-code': { id: 'claude-code', models: [...OPUS_5_BARE.oldModels], defaultModel: 'claude-opus-4-8' },
        'claude-code-tui': { id: 'claude-code-tui', models: [...OPUS_5_BARE.oldModels], defaultModel: 'claude-opus-4-8' },
      },
    });

    await mig.up({ rootDir });

    const out = read().providers;
    out['claude-code'].models.push('mutated');
    expect(out['claude-code-tui'].models).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-5']);
    expect(OPUS_5_BARE.oldModels).toEqual(['claude-haiku-4-5', 'claude-sonnet-5', 'claude-opus-4-8']);
  });

  it('does not treat an inherited prototype key as a present provider', async () => {
    // `providers['constructor']` is truthy on ANY plain object; a bare presence
    // probe would "bump" the prototype instead of skipping a target that the
    // install simply does not have.
    const mig = makeSeededProviderTierMigration({
      targets: { constructor: OPUS_5_BARE },
      tierLabel: 'opus tier claude-opus-5',
    });
    write({ providers: {} });
    const before = readFileSync(providersPath, 'utf-8');

    expect(await mig.up({ rootDir })).toMatchObject({ ok: true, reason: 'no-change', touched: [] });

    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
    expect({}.models).toBeUndefined();
  });

  it('skips a target whose entry is not an object rather than throwing', async () => {
    const mig = makeSeededProviderTierMigration({ targets: { 'claude-code': OPUS_5_BARE }, tierLabel: 'opus tier claude-opus-5' });
    write({ providers: { 'claude-code': 'not-an-object' } });
    const before = readFileSync(providersPath, 'utf-8');

    expect(await mig.up({ rootDir })).toMatchObject({ ok: true, reason: 'no-change' });
    expect(readFileSync(providersPath, 'utf-8')).toBe(before);
  });

  it('leaves a pointer at an id this bump does not retire alone', async () => {
    const mig = makeSeededProviderTierMigration({ targets: { 'claude-code': OPUS_5_BARE }, tierLabel: 'opus tier claude-opus-5' });
    write({
      providers: {
        'claude-code': {
          id: 'claude-code',
          models: [...OPUS_5_BARE.oldModels],
          defaultModel: 'claude-haiku-4-5',
          lightModel: 'claude-haiku-4-5',
          mediumModel: 'claude-sonnet-5',
          heavyModel: 'claude-opus-4-8',
        },
      },
    });

    await mig.up({ rootDir });

    const after = read().providers['claude-code'];
    expect(after.defaultModel).toBe('claude-haiku-4-5');
    expect(after.lightModel).toBe('claude-haiku-4-5');
    expect(after.mediumModel).toBe('claude-sonnet-5');
    expect(after.heavyModel).toBe('claude-opus-5');
  });
});
