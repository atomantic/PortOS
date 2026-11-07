import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { encodeMessage } from '../lib/protobufWire.js';
import { unionNativeClaudeRecords } from '../lib/nativeUsageRecords.js';
import { unionNativeGrokRecords } from '../lib/nativeGrokUsageRecords.js';

const harness = vi.hoisted(() => ({ opened: [], home: '/nonexistent-native-usage-home' }));
const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'native-usage-collection-' });
vi.mock('../lib/fileUtils.js', async original => makeProxy(await original()));
vi.mock('node:fs/promises', async original => {
  const actual = await original();
  return { ...actual, open: (path, ...rest) => {
    harness.opened.push(String(path));
    return actual.open(path, ...rest);
  } };
});
vi.mock('node:os', async original => ({ ...await original(), homedir: () => harness.home }));
vi.mock('./codexAppServer.js', () => ({ getCodexAccountUsageEvidence: vi.fn() }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'synthetic-instance') }));
vi.mock('./settings.js', () => ({ getSettingsWithStatus: vi.fn() }));
vi.mock('./eventScheduler.js', () => ({ schedule: vi.fn() }));
const { PATHS } = await import('../lib/fileUtils.js');
const { getCodexAccountUsageEvidence } = await import('./codexAppServer.js');
const { schedule } = await import('./eventScheduler.js');
const { captureDashboardNativeUsageReport, captureNativeUsageReport, NATIVE_USAGE_DASHBOARD_LIMITS } = await import('./nativeUsageReport.js');
const { collectNativeUsageSources, requestNativeUsageRebuild } = await import('./nativeUsageCollection.js');
const { startNativeUsageCollectionSchedule } = await import('./nativeUsageCollectionSchedule.js');
const { getNativeUsageSnapshot, _resetNativeUsageStore } = await import('./nativeUsageStore.js');

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '../lib/fixtures/nativeUsageModelAttribution/v1');
const corpus = name => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const NOW = () => new Date('2026-03-01T12:00:00.000Z');
const FAMILIES = ['agy', 'claude', 'grok'];
const SIGNED_IN = { status: 'read', account: { authMethod: 'chatgpt', planType: 'pro', email: 'alice@example.com' } };
const codexRead = (tokens = 300) => ({ runtimeVersion: '0.166.0', accountBefore: SIGNED_IN, accountAfter: SIGNED_IN,
  usage: { summary: { lifetimeTokens: tokens }, dailyUsageBuckets: [{ startDate: '2026-01-01', tokens }] } });

const home = () => harness.home;
const entry = (report, family) => report.providers.find(provider => provider.family === family);
const stored = () => captureDashboardNativeUsageReport();
const fullRead = () => captureNativeUsageReport({ home: home(), limits: NATIVE_USAGE_DASHBOARD_LIMITS, now: NOW });
const sourcesOpened = () => harness.opened.filter(path => path.startsWith(home()));
/** A stored read must report exactly what reading the same tree from nothing reports. */
const expectSameAsFullRead = async report => {
  const full = await fullRead();
  expect(report.providers).toEqual(full.providers);
  expect(report.evidenceHash).toBe(full.evidenceHash);
};

const save = async (path, text) => {
  const target = join(home(), path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  return target;
};
const claudeLine = (id, output = 5, extra = {}) => JSON.stringify({ type: 'assistant', requestId: `private-request-${id}`, timestamp: '2026-01-01T00:00:00Z', version: '2.1.0',
  message: { id: `private-message-${id}`, stop_reason: 'end_turn', content: 'private transcript text', usage: { input_tokens: 10, output_tokens: output, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } }, ...extra });
const claudePath = name => `.claude/projects/private-project/${name}.jsonl`;
const claudeTokens = report => entry(report, 'claude').totals?.totalTokens;

const grokFields = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'modelCalls'];
const grokSnapshot = (sessionId, totals = [100, 20, 80, 0, 10, 120, 2]) => {
  const turn = { turnNumber: 1, endedAt: '2026-01-02T03:04:05.000Z', turnCount: 1, costUsdTicks: 7, ...Object.fromEntries(grokFields.map((field, index) => [field, totals[index]])) };
  return JSON.stringify({ sessionId, updatedAt: turn.endedAt, turns: [turn], session: { ...Object.fromEntries(grokFields.map(field => [field, turn[field]])), turnCount: 1 } });
};

const timestamp = { seconds: { no: 1, type: 'varint' } };
const usageSchema = Object.fromEntries([['model', 1, 'varint'], ['inputTokens', 2, 'varint'], ['outputTokens', 3, 'varint'], ['cacheWriteTokens', 4, 'varint'], ['cacheReadTokens', 5, 'varint'],
  ['apiProvider', 6, 'varint'], ['messageId', 7, 'string'], ['thinkingOutputTokens', 9, 'varint'], ['responseOutputTokens', 10, 'varint'], ['responseId', 11, 'string']].map(([name, no, type]) => [name, { no, type }]));
const metadataSchema = { created: { no: 1, type: 'message', schema: timestamp }, completed: { no: 8, type: 'message', schema: timestamp }, usage: { no: 9, type: 'message', schema: usageSchema } };
const agyDatabase = async (name, ids) => {
  const path = join(home(), '.gemini/antigravity-cli/conversations', `${name}.db`);
  await mkdir(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL DEFAULT 0, status INTEGER NOT NULL DEFAULT 0, has_subtrajectory NUMERIC NOT NULL DEFAULT false,
    metadata BLOB, error_details BLOB, permissions BLOB, task_details BLOB, render_info BLOB, step_payload BLOB, step_format INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE trajectory_meta (trajectory_id TEXT PRIMARY KEY, cascade_id TEXT, trajectory_type INTEGER, source INTEGER); PRAGMA user_version=1;`);
  db.prepare('INSERT INTO trajectory_meta (trajectory_id, cascade_id) VALUES (?, ?)').run('synthetic-trajectory', name);
  ids.forEach((id, index) => db.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_format) VALUES (?, 15, 3, ?, 0)').run(index, encodeMessage(metadataSchema, {
    created: { seconds: 1772323200 }, completed: { seconds: 1772323201 },
    usage: { model: 342, apiProvider: 24, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, thinkingOutputTokens: 3, responseOutputTokens: 2, messageId: `private-message-${id}`, responseId: `private-response-${id}` },
  })));
  db.close();
  return path;
};
const storeText = async () => {
  const walk = async dir => (await Promise.all((await readdir(dir, { withFileTypes: true })).map(item => (item.isDirectory()
    ? walk(join(dir, item.name)) : readFile(join(dir, item.name), 'utf8'))))).flat();
  return (await walk(join(PATHS.data, 'native-usage'))).join('\n');
};

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv('CLAUDE_CONFIG_DIR', '');
  harness.home = await mkdtemp(join(tmpdir(), 'native-collection-home-'));
  harness.opened.length = 0;
  await _resetNativeUsageStore();
  getCodexAccountUsageEvidence.mockResolvedValue(codexRead());
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(harness.home, { recursive: true, force: true });
});
afterAll(cleanup);

describe('collecting only what changed', () => {
  it('opens no source on a second read of an unchanged tree, with the same report', async () => {
    await save(claudePath('a'), `${claudeLine('a')}\n`);
    await save('.grok/sessions/project/session/usage.json', grokSnapshot('session'));
    await agyDatabase('conversation', ['a']);
    const first = await stored();
    await expectSameAsFullRead(first);
    harness.opened.length = 0;
    const second = await stored();
    expect(sourcesOpened()).toEqual([]);
    expect(second.providers).toEqual(first.providers);
    expect(second.evidenceHash).toBe(first.evidenceHash);
  });

  it('keeps a vendor-flagged incomplete Grok turn flagged when it is served from the store', async () => {
    const snapshot = JSON.parse(grokSnapshot('session'));
    snapshot.turns[0].usageIsIncomplete = true;
    await save('.grok/sessions/project/session/usage.json', JSON.stringify(snapshot));
    await stored();
    harness.opened.length = 0;
    const report = await stored();
    expect(sourcesOpened()).toEqual([]);
    expect(entry(report, 'grok').findings).toContain('native-usage-incomplete');
    await expectSameAsFullRead(report);
  });

  it('re-reads only an appended file, and matches a fresh full read', async () => {
    const appended = await save(claudePath('active'), `${claudeLine('a')}\n`);
    await save(claudePath('old'), `${claudeLine('b')}\n`);
    await stored();
    await writeFile(appended, `${claudeLine('a')}\n${claudeLine('c')}\n`);
    harness.opened.length = 0;
    const report = await stored();
    expect(sourcesOpened()).toEqual([appended]);
    expect(claudeTokens(report)).toBe(60);
    await expectSameAsFullRead(report);
  });

  it('folds a streamed response written across files as one read would', async () => {
    const partial = line => { const parsed = JSON.parse(line); parsed.message.stop_reason = null; return JSON.stringify(parsed); };
    await save(claudePath('early'), `${partial(claudeLine('a', 2))}\n${partial(claudeLine('a', 4))}\n`);
    await stored();
    await save(claudePath('late'), `${claudeLine('a', 9)}\n`);
    const report = await stored();
    expect(entry(report, 'claude').duplicates).toMatchObject({ conflictingRecords: 0, streamingSupersededRecords: 2 });
    expect(entry(report, 'claude').totals).toMatchObject({ tokensOut: 9 });
    await expectSameAsFullRead(report);
  });

  it('keeps a deleted source counted, and says so', async () => {
    const claude = await save(claudePath('swept'), `${claudeLine('a')}\n`);
    const grok = await save('.grok/sessions/project/session/usage.json', grokSnapshot('session'));
    const agy = await agyDatabase('conversation', ['a']);
    const before = await stored();
    await Promise.all([claude, grok, agy].map(path => rm(path)));
    const after = await stored();
    for (const family of FAMILIES) {
      expect(entry(after, family).totals, family).toEqual(entry(before, family).totals);
      expect(entry(after, family).findings, family).toContain('collected-sources-detached');
      expect(entry(after, family).coverage.missingSource, family).toBe(false);
    }
  });

  it('replaces only its own contribution when a file shrinks or is rewritten, with no false conflict', async () => {
    const rewritten = await save(claudePath('rewritten'), `${claudeLine('a', 100)}\n${claudeLine('b')}\n`);
    await save(claudePath('other'), `${claudeLine('c')}\n`);
    await stored();
    await writeFile(rewritten, `${claudeLine('a', 7)}\n`);
    const report = await stored();
    expect(entry(report, 'claude').duplicates.conflictingRecords).toBe(0);
    expect(entry(report, 'claude').totals.tokensOut).toBe(12);
    await expectSameAsFullRead(report);
  });

  it('does not double count a collected file copied to a new path, in any family', async () => {
    const claude = await save(claudePath('original'), `${claudeLine('a')}\n`);
    const grok = await save('.grok/sessions/project/session/usage.json', grokSnapshot('session'));
    const agy = await agyDatabase('conversation', ['a']);
    const before = await stored();
    await save(claudePath('copied'), await readFile(claude));
    await save('.grok/sessions/moved/session/usage.json', await readFile(grok));
    harness.opened.length = 0;
    const after = await stored();
    expect(sourcesOpened()).not.toContain(agy);
    expect(entry(after, 'claude').totals).toEqual(entry(before, 'claude').totals);
    expect(entry(after, 'claude').duplicates.duplicateRecords).toBe(1);
    expect(entry(after, 'grok').totals).toEqual(entry(before, 'grok').totals);
    await expectSameAsFullRead(after);
  });

  it('resumes a run stopped at its budget without re-reading finished sources', async () => {
    const line = `${claudeLine('a')}\n`;
    const paths = await Promise.all(['one', 'two'].map(name => save(claudePath(name), name === 'one' ? line : line.replaceAll('private-message-a', 'private-message-b'))));
    const limits = { ...NATIVE_USAGE_DASHBOARD_LIMITS, bytes: Math.floor(Buffer.byteLength(line) * 1.5) };
    const stopped = (await collectNativeUsageSources({ limits })).transcripts.claude;
    expect(stopped.coverage.stoppedEarly).toBe(true);
    expect(stopped.summary.totalTokens).toBe(20);
    const finished = sourcesOpened()[0];
    harness.opened.length = 0;
    const resumed = (await collectNativeUsageSources({ limits })).transcripts.claude;
    expect(sourcesOpened()).toEqual(paths.filter(path => path !== finished));
    expect(resumed.coverage.stoppedEarly).toBe(false);
    expect(resumed.summary.totalTokens).toBe(40);
  });

  it('forces a read while an Antigravity database has sidecars, keeping its earlier projection', async () => {
    const path = await agyDatabase('conversation', ['a']);
    const before = await stored();
    await writeFile(`${path}-wal`, 'pending writes');
    const during = await stored();
    expect(entry(during, 'agy').nativeAgyCoverage.unstableDatabases).toBe(1);
    expect(entry(during, 'agy').recordProjection.truncated).toBe(true);
    expect(entry(during, 'agy').totals).toEqual(entry(before, 'agy').totals);
    await rm(`${path}-wal`);
    harness.opened.length = 0;
    const after = await stored();
    expect(sourcesOpened()).toEqual([]);
    expect(entry(after, 'agy').recordProjection.truncated).toBe(false);
  });

  it('rebuild re-reads a rewrite that kept size and mtime, and keeps sources that are gone', async () => {
    const rewritten = await save(claudePath('rewritten'), `${claudeLine('a', 5)}\n`);
    const gone = await save(claudePath('gone'), `${claudeLine('b', 5)}\n`);
    const pinned = new Date('2026-01-01T00:00:00.000Z');
    await utimes(rewritten, pinned, pinned);
    await stored();
    await writeFile(rewritten, `${claudeLine('a', 6)}\n`);
    await utimes(rewritten, pinned, pinned);
    await rm(gone);
    expect(entry(await stored(), 'claude').totals.tokensOut).toBe(10);
    await requestNativeUsageRebuild();
    expect(entry(await stored(), 'claude').totals.tokensOut).toBe(11);
  });

  it('re-reads a family when its validator changes, and refuses a projection it cannot fold', async () => {
    const present = await save(claudePath('present'), `${claudeLine('a')}\n`);
    const gone = await save(claudePath('gone'), `${claudeLine('b')}\n`);
    await stored();
    await rm(gone);
    const dir = join(PATHS.data, 'native-usage/sources/claude');
    for (const name of await readdir(dir)) {
      const row = JSON.parse(await readFile(join(dir, name), 'utf8'));
      await writeFile(join(dir, name), JSON.stringify({ ...row, validator: 'claude-retained-messages/0' }));
    }
    harness.opened.length = 0;
    const report = await stored();
    expect(sourcesOpened()).toEqual([present]);
    expect(entry(report, 'claude').findings).toContain('stored-projection-unsupported');
    expect(claudeTokens(report)).toBe(20);
  });
});

describe('#15230 corpus across separate collection runs', () => {
  const writers = {
    claude: (scenario, index) => scenario.reports.flatMap(({ entries }) => entries).map((line, copy) => [claudePath(`s${index}-${copy}`), `${JSON.stringify(line)}\n`]),
    grok: (scenario, index) => scenario.reports.flatMap(({ snapshots }) => snapshots).map((snapshot, copy) => [`.grok/sessions/s${index}/${copy}/usage.json`, JSON.stringify(snapshot)]),
  };
  const unions = { claude: unionNativeClaudeRecords, grok: unionNativeGrokRecords };

  for (const family of ['claude', 'grok']) {
    it.each(corpus(`${family}.json`).scenarios.map((scenario, index) => [scenario.name, scenario, index]))(`${family}: %s`, async (_name, scenario, index) => {
      for (const [path, text] of writers[family](scenario, index)) {
        await save(path, text);
        await stored();
      }
      const report = await stored();
      await expectSameAsFullRead(report);
      const union = unions[family]([entry(report, family).recordProjection]);
      expect(union.coverage.uniqueRecords).toBe(scenario.expect.records.length);
      if (scenario.expect.providerTotals) expect(union.totals).toEqual(expect.objectContaining(scenario.expect.providerTotals));
      else expect(union.totals).toBeNull();
    });
  }
});

describe('what the store keeps', () => {
  it('holds no path, text or raw identifier', async () => {
    await save(claudePath('private-file'), `${claudeLine('a')}\n`);
    await save('.grok/sessions/private-project/private-session/usage.json', grokSnapshot('private-session'));
    await agyDatabase('private-conversation', ['a']);
    await stored();
    const text = await storeText();
    expect(text.length).toBeGreaterThan(0);
    for (const secret of ['private-', home(), 'alice@example.com', 'transcript text']) expect(text).not.toContain(secret);
  });

  it('shows the stored Codex entry on a failed refresh, marked so it cannot be authoritative, and keeps no email', async () => {
    const live = await stored();
    expect(entry(live, 'codex')).toMatchObject({ status: 'available', totals: { lifetimeTokens: 300 } });
    expect(JSON.stringify(await getNativeUsageSnapshot('codex-account', 'latest'))).not.toContain('alice@example.com');
    getCodexAccountUsageEvidence.mockResolvedValue({ runtimeVersion: '0.166.0', accountBefore: SIGNED_IN, accountAfter: SIGNED_IN, usage: null, failureCode: 'CODEX_APP_SERVER_TIMEOUT' });
    const failed = await stored();
    expect(entry(failed, 'codex')).toMatchObject({ status: 'partial', totals: { lifetimeTokens: 300 } });
    expect(entry(failed, 'codex').findings).toContain('retained-snapshot');
    expect(await getNativeUsageSnapshot('codex-account', 'latest')).toEqual(entry(live, 'codex'));
  });

  it('reports a signed-out Codex account as signed out, not from the stored entry', async () => {
    await stored();
    const signedOut = { status: 'read', account: null };
    getCodexAccountUsageEvidence.mockResolvedValue({ runtimeVersion: '0.166.0', accountBefore: signedOut, accountAfter: signedOut, usage: null, failureCode: null });
    expect(entry(await stored(), 'codex')).toMatchObject({ status: 'absent', totals: null, findings: ['signed-out'] });
  });
});

describe('daily collection', () => {
  it('registers a cron with no boot run, and a run reads files without any account read', async () => {
    await save(claudePath('a'), `${claudeLine('a')}\n`);
    startNativeUsageCollectionSchedule();
    expect(schedule).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ type: 'cron', cron: expect.any(String) }));
    expect(sourcesOpened()).toEqual([]);
    await schedule.mock.calls[0][0].handler();
    expect(sourcesOpened()).toHaveLength(1);
    expect(getCodexAccountUsageEvidence).not.toHaveBeenCalled();
    harness.opened.length = 0;
    expect(claudeTokens(await stored())).toBe(20);
    expect(sourcesOpened()).toEqual([]);
  });

  it('spends a slow Codex read from the same budget, so the sources stop rather than the peer timing out', async () => {
    await save(claudePath('a'), `${claudeLine('a')}\n`);
    const realNow = Date.now.bind(Date);
    let skew = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + skew);
    getCodexAccountUsageEvidence.mockImplementationOnce(async () => {
      skew = NATIVE_USAGE_DASHBOARD_LIMITS.milliseconds + 1;
      return codexRead();
    });
    const report = await stored();
    vi.restoreAllMocks();
    expect(sourcesOpened()).toEqual([]);
    expect(entry(report, 'claude').scanCaps.stoppedEarly).toBe(true);
  });

  it('never interleaves two runs over the same changed file', async () => {
    const path = await save(claudePath('a'), `${claudeLine('a')}\n`);
    await Promise.all([collectNativeUsageSources({ limits: NATIVE_USAGE_DASHBOARD_LIMITS }), collectNativeUsageSources({ limits: NATIVE_USAGE_DASHBOARD_LIMITS })]);
    expect(sourcesOpened()).toEqual([path]);
  });

  it('surfaces a store failure instead of reporting it as an unreadable file', async () => {
    await save(claudePath('a'), `${claudeLine('a')}\n`);
    const blocker = join(PATHS.data, 'native-usage');
    await mkdir(dirname(blocker), { recursive: true });
    await writeFile(blocker, 'not a directory');
    await expect(collectNativeUsageSources({ limits: NATIVE_USAGE_DASHBOARD_LIMITS })).rejects.toThrow();
    await rm(blocker);
    await copyFile(join(home(), claudePath('a')), join(home(), claudePath('b')));
    expect(claudeTokens(await stored())).toBe(20);
  });
});
