import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNativeUsageRehearsalCli } from './native-usage-rehearse.js';
import { nativeUsageCanonicalJson, reportIsIntact } from '../server/lib/nativeUsageContract.js';
import { capture, inventory, json, prepare, put } from './lib/nativeUsageSources.testFixture.js';

let dir;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), 'native-sources-')));
  const scratch = join(dir, 'tmp'); await mkdir(scratch);
  for (const name of ['TMPDIR', 'TMP', 'TEMP']) vi.stubEnv(name, scratch);
  vi.stubEnv('PORTOS_TEST_TEMP_ROOT', undefined);
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
async function run(args) {
  let stdout = ''; let stderr = '';
  const code = await runNativeUsageRehearsalCli(args, { stdout: value => { stdout += value; }, stderr: value => { stderr += value; } });
  return { code, stdout, stderr, result: stdout ? JSON.parse(stdout) : null };
}
const backup = f => run(['sources-backup', f.stagePath, f.requestPath, f.source, f.bundle]);
const restore = f => run(['sources-restore', f.stagePath, f.bundle, f.restored]);
const retained = report => report.providers.filter(entry => entry.family !== 'codex');
const safe = output => {
  expect(output.stdout + output.stderr).not.toContain(dir);
  expect(output.stdout + output.stderr).not.toMatch(/private-(?:project|session|native|message|response|model|rollout|app|ide|future|archive)/);
};
const gatesClosed = receipt => expect(receipt).toMatchObject({ fullStoreInventoryVerified: false, fullRecoveryBackup: false,
  activationReady: false, codex: { accountHistoryReplayed: false } });

describe('public detached native source preservation and replay', () => {
  it('restores every raw byte and empty directory after loss of originals and exactly replays all retained entries', async () => {
    const f = await prepare(dir);
    expect(reportIsIntact(f.report)).toBe(true);
    const original = await inventory(f.source);
    const agy = f.report.providers.find(entry => entry.family === 'agy');
    expect(agy).toMatchObject({ totals: { totalTokens: null, tokensIn: 20, tokensOut: 10, cacheReadTokens: 200,
      thinkingOutputTokens: 6, responseOutputTokens: 4 }, nativeAgyCoverage: { validDatabases: 1, checkpointRecords: 1,
      unverifiedAppFiles: 1, unverifiedIdeFiles: 2 } });
    expect(f.report.providers.find(entry => entry.family === 'claude').duplicates).toMatchObject({ conflictingRecords: 1, streamingSupersededRecords: 1 });
    expect(f.report.providers.find(entry => entry.family === 'grok')).toMatchObject({ totals: { totalTokens: 15 },
      nativeUsageCoverage: { validSnapshots: 3, invalidSnapshots: 0 }, cost: { actualSpendUsd: null,
        nativeCostSignal: { knownCostUsdTicks: null, conflictingRecords: 1 } } });
    const saved = await backup(f);
    expect(saved.code).toBe(3); safe(saved); gatesClosed(saved.result);
    const manifest = JSON.parse(await readFile(join(f.bundle, 'manifest.json')));
    expect(manifest.fileCount).toBe(Object.keys(original.files).length + 2);
    expect(manifest.files).toMatchObject(Object.fromEntries(Object.entries(original.files).map(([name, bytes]) => [name, createHash('sha256').update(bytes).digest('hex')])));
    const sidecar = JSON.parse(await readFile(join(f.bundle, 'data/native-sources.json')));
    expect(sidecar).toMatchObject({ version: 1, stageHash: f.stage.contentHash, reportHash: f.report.contentHash, participantKey: f.report.participantKey, roles: f.request.roles });
    await rm(f.source, { recursive: true });
    const ambient = join(dir, 'ambient');
    await put(ambient, '.claude/projects/sentinel/session.jsonl', '{"type":"assistant","message":{"id":"ambient-only","usage":{"input_tokens":9999,"output_tokens":9999}}}\n');
    await put(ambient, '.codex/sessions/sentinel.jsonl', '{"total_tokens":999999}\n');
    await put(ambient, '.grok/sessions/sentinel/usage.json', '{}');
    vi.stubEnv('HOME', ambient); vi.stubEnv('CODEX_HOME', join(ambient, '.codex')); vi.stubEnv('CLAUDE_CONFIG_DIR', join(ambient, '.claude'));
    const restored = await restore(f);
    expect(restored.code).toBe(3); safe(restored); gatesClosed(restored.result);
    expect(restored.result).toMatchObject({ retainedReplayVerified: true, stageRebuiltWithPreservedCodexEvidence: true, retainedProviders: { agy: 'matched', claude: 'matched', grok: 'matched' } });
    const restoredData = await inventory(join(f.restored, 'data'));
    delete restoredData.files['native-sources.json']; delete restoredData.files['participant-report.json'];
    expect(restoredData).toEqual(original);
    for (const name of ['manifest.json', 'data/native-sources.json', 'data/participant-report.json']) expect(await readFile(join(f.restored, name))).toEqual(await readFile(join(f.bundle, name)));
    const replayed = await capture(join(f.restored, 'data'));
    expect(nativeUsageCanonicalJson(retained(replayed))).toBe(nativeUsageCanonicalJson(retained(f.report)));
    expect(await readFile(join(ambient, '.codex/sessions/sentinel.jsonl'), 'utf8')).toContain('999999');
    expect(await readdir(f.bundle)).not.toContain('.in-progress');
    if (process.platform !== 'win32') expect((await stat(f.bundle)).mode & 0o777).toBe(0o700);
  });

  it('preserves explicit detached absence without claiming zero account history or discovering ambient history', async () => {
    const f = await prepare(dir, { absent: true });
    const ambient = join(dir, 'ambient');
    await put(ambient, 'projects/private-ambient/session.jsonl', '{}\n');
    vi.stubEnv('HOME', ambient); vi.stubEnv('CODEX_HOME', ambient); vi.stubEnv('CLAUDE_CONFIG_DIR', ambient);
    expect((await backup(f)).code).toBe(3);
    const result = await restore(f);
    expect(result.code).toBe(3); gatesClosed(result.result); safe(result);
    expect(JSON.parse(await readFile(join(f.restored, 'data/native-sources.json'))).roles).toEqual(f.request.roles);
    expect((await inventory(join(f.restored, 'data'))).directories).toEqual([]);
    expect(await readdir(join(f.restored, 'data'))).toEqual(['native-sources.json', 'participant-report.json']);
  });

  it('refuses replay proof for unknown roots even when missing scans match and keeps preserved bytes', async () => {
    const f = await prepare(dir, { absent: true });
    f.request.roles.claudeProjects = 'not-supplied/unknown';
    f.request.roles.agyAppConversations = 'not-supplied/unknown';
    f.request.roles.codexSessions = 'provided';
    await put(f.source, 'codexSessions/private-rollout.jsonl', '{"private":"preserve opaque source"}\n');
    await writeFile(f.requestPath, json(f.request));
    expect((await backup(f)).code).toBe(3);
    await rm(f.source, { recursive: true });
    const output = await restore(f);
    expect(output.code).toBe(1); gatesClosed(output.result); safe(output);
    expect(output.result).toMatchObject({ sourceBytesVerified: true, retainedReplayVerified: false,
      stageRebuiltWithPreservedCodexEvidence: false,
      retainedProviders: { claude: 'not-supplied', agy: 'not-supplied', grok: 'matched' } });
    expect(nativeUsageCanonicalJson(retained(await capture(join(f.restored, 'data')))))
      .toBe(nativeUsageCanonicalJson(retained(f.report)));
    expect(await readFile(join(f.restored, 'data/codexSessions/private-rollout.jsonl'), 'utf8'))
      .toBe('{"private":"preserve opaque source"}\n');
    for (const name of ['manifest.json', 'data/native-sources.json', 'data/participant-report.json']) {
      expect(await readFile(join(f.restored, name))).toEqual(await readFile(join(f.bundle, name)));
    }
    expect(JSON.parse(await readFile(join(f.restored, 'replay.json'))).retainedReplayVerified).toBe(false);
  });

  it('accepts a canonical source beneath an ancestor alias but refuses an aliased source root', async () => {
    const real = join(dir, 'real'); await mkdir(real);
    const f = await prepare(real, { absent: true });
    const alias = join(dir, 'ancestor-alias');
    await symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    f.source = join(alias, 'detached');
    expect((await backup(f)).code).toBe(3);
    f.bundle = join(alias, 'bundle');
    expect((await restore(f)).code).toBe(3);
    const rootAlias = join(dir, 'source-root-alias');
    await symlink(join(real, 'detached'), rootAlias, process.platform === 'win32' ? 'junction' : 'dir');
    f.source = rootAlias; f.bundle = join(dir, 'refused-bundle');
    await expect(backup(f)).rejects.toThrow();
    await expect(stat(f.bundle)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retains legacy-only Antigravity and opaque App/IDE sources without claiming measured history', async () => {
    const f = await prepare(dir, { legacyOnly: true });
    expect(f.report.providers.find(entry => entry.family === 'agy')).toMatchObject({ totals: null, nativeAgyCoverage: { legacyOnlySources: 1 } });
    expect((await backup(f)).code).toBe(3);
    const output = await restore(f);
    expect(output.code).toBe(3);
    expect(await readFile(join(f.restored, 'data/agyAppConversations/private-app.pb'))).toEqual(Buffer.from([0, 128, 255, 42]));
    gatesClosed(output.result); safe(output);
  });

  it('cannot turn changed raw Codex files into account evidence, while retained mismatch keeps useful restored bytes', async () => {
    const f = await prepare(dir);
    const originalReport = await readFile(f.stagePath);
    await put(f.source, 'codexSessions/private-rollout.jsonl', '{"lifetimeTokens":123456789}\n');
    expect((await backup(f)).code).toBe(3);
    const first = await restore(f);
    expect(first.code).toBe(3); gatesClosed(first.result);
    expect(await readFile(f.stagePath)).toEqual(originalReport);
    expect(await readFile(join(f.restored, 'data/codexSessions/private-rollout.jsonl'), 'utf8')).toContain('123456789');
    f.bundle = join(dir, 'changed-bundle'); f.restored = join(dir, 'changed-restore');
    await put(f.source, 'claudeProjects/private-project/session.jsonl', '{}\n');
    expect((await backup(f)).code).toBe(3);
    const changed = await restore(f);
    expect(changed.code).toBe(1); gatesClosed(changed.result); safe(changed);
    expect(changed.result).toMatchObject({ retainedReplayVerified: false, stageRebuiltWithPreservedCodexEvidence: false, retainedProviders: { claude: 'mismatch' } });
    expect(JSON.parse(await readFile(join(f.restored, 'replay.json'))).retainedReplayVerified).toBe(false);
    expect(await readFile(join(f.restored, 'data/claudeProjects/private-project/session.jsonl'), 'utf8')).toBe('{}\n');
    expect(await readFile(join(f.restored, 'manifest.json'))).toEqual(await readFile(join(f.bundle, 'manifest.json')));
  });

  it('claims an exact fresh destination once across concurrency and refuses repeats without changing its bytes', async () => {
    const f = await prepare(dir, { absent: true });
    const results = await Promise.allSettled([backup(f), backup(f)]);
    expect(results.filter(row => row.status === 'fulfilled' && row.value.code === 3)).toHaveLength(1);
    expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
    const original = await inventory(f.bundle);
    await expect(backup(f)).rejects.toThrow();
    expect(await inventory(f.bundle)).toEqual(original);
    expect((await restore(f)).code).toBe(3);
    const restored = await inventory(f.restored);
    await expect(restore(f)).rejects.toThrow();
    expect(await inventory(f.restored)).toEqual(restored);
  });
});
