import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fenceBlock } from '../lib/promptFencing.js';
import { PRIVACY_FACTS_HEADING, PRIVACY_FACTS_NOTICE, redactStoredPrivacyPrompt, trackPrivateRunOutput } from '../lib/privacyPrompt.js';
import { PRIVACY_SELF_SUBJECT_ID } from '../lib/privacyConstants.js';
import { encryptValue } from '../lib/vaultCrypto.js';
import { deleteVaultRecord, updateVaultRecord } from './privacyVault.js';
import { clearSubjectIdentityEvidence } from './privacyBrokers.js';
import { createRunnerService } from '../lib/aiToolkit/runner.js';
import { withRuntimeFileTurn } from '../lib/runtimeFilePublication.js';
import { deleteSubject } from './privacySubjects.js';
import { cleanHistoricalTwinArtifacts } from './privacyTwinHistory.js';
import { scrubRevokedPrivacyFacts } from './privacyPromptScrub.js';
import { createOutputSpooler } from './agentTuiSpawning/outputSpooler.js';

const { providerRequest } = vi.hoisted(() => ({ providerRequest: vi.fn() }));
vi.mock('../lib/aiToolkit/internal/streamTransport.js', () => ({ requestProviderStream: providerRequest }));

vi.mock('./cos/cosAgentLifecycle.js', () => ({ updateAgent: vi.fn(async () => {}), appendAgentOutputLines: vi.fn() }));
vi.mock('../lib/tuiHandshake.js', async actual => ({ ...await actual(), RAW_SPOOL_MAX_BYTES: 256 }));

const fixtures = vi.hoisted(() => ({ paths: {}, query: vi.fn(), failWrite: null }));
vi.mock('../lib/db.js', () => ({
  query: fixtures.query,
  withTransaction: fn => fn({ query: fixtures.query }),
}));
vi.mock('../lib/fileUtils.js', async actual => {
  const module = await actual();
  return {
    ...module,
    PATHS: Object.assign(fixtures.paths, module.PATHS),
    atomicWrite: async (path, ...args) => {
      if (fixtures.failWrite === path) {
        fixtures.failWrite = null;
        throw new Error('Fixture write failure');
      }
      return module.atomicWrite(path, ...args);
    },
  };
});
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: work => work() }));
vi.mock('./messageDrafts.js', () => ({ erasePrivacyDrafts: vi.fn(async () => ({})), scrubLegacyPrivacyDraftValues: vi.fn(async () => 0) }));
vi.mock('./privacyBrokers.js', () => ({ clearSubjectIdentityEvidence: vi.fn() }));

const fact = 'Skylar Example';
const survivor = 'independent test content';
const previewStart = 'p'.repeat(150);
const prompt = `${previewStart}\n${fenceBlock('Digital twin reference data', [
  PRIVACY_FACTS_HEADING, PRIVACY_FACTS_NOTICE, `- Name — legal_name: ${fact}`, '', '---', '', survivor,
].join('\n'), 4000)}`;
const output = `${fact} — ${survivor}; similar: ${fact}son`;
const rawOutput = `\u001b[32m> ${output}\u001b[0m\r\n`;
const compressedRaw = gzipSync(rawOutput);
const recordingManifest = {
  version: 1, pinned: true, disposition: 'compressed', compressedAt: '2026-01-02T00:00:00.000Z',
  sha256: createHash('sha256').update(rawOutput).digest('hex'), originalBytes: Buffer.byteLength(rawOutput),
};

let root;
let paths;
let log;
let warn;
let error;

async function writeFixture(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  vi.stubEnv('PRIVACY_VAULT_KEY', 'a'.repeat(64));
  clearSubjectIdentityEvidence.mockClear();
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  root = await mkdtemp(join(tmpdir(), 'privacy-prompt-scrub-'));
  Object.assign(fixtures.paths, { cosAgents: join(root, 'agents'), runs: join(root, 'runs'), digitalTwin: join(root, 'digital-twin') });
  paths = {
    agent: join(fixtures.paths.cosAgents, '2026-01-01', 'agent-example'),
    flatAgent: join(fixtures.paths.cosAgents, 'agent-active'),
    twinRun: join(fixtures.paths.runs, 'twin-run'),
    cosRun: join(fixtures.paths.runs, 'cos-run'),
    unrelated: join(fixtures.paths.runs, 'unrelated-run'),
    unrelatedAgent: join(fixtures.paths.cosAgents, '2026-01-01', 'unrelated-agent'),
    backup: join(root, 'backups', 'runs', 'twin-run'),
  };
  await Promise.all(Object.values(paths).flatMap(directory => [
    writeFixture(join(directory, 'prompt.txt'), [paths.cosRun, paths.unrelated, paths.unrelatedAgent].includes(directory) ? survivor : prompt),
    writeFixture(join(directory, 'output.txt'), output),
  ]));
  await Promise.all([
    writeFixture(join(paths.twinRun, 'metadata.json'), JSON.stringify({ purpose: 'test', prompt: prompt.slice(0, 500) })),
    writeFixture(join(paths.cosRun, 'metadata.json'), JSON.stringify({ agentId: 'agent-example', prompt: survivor })),
  ]);
  const row = { id: 'record-example', subject_id: PRIVACY_SELF_SUBJECT_ID, type: 'legal_name', value_enc: encryptValue(fact) };
  fixtures.query.mockReset().mockImplementation(async sql => {
    if (sql.includes('SELECT id FROM privacy_subjects')) return { rows: [{ id: 'subject-example' }] };
    if (sql.includes('DELETE FROM privacy_subjects')) return { rows: [] };
    return { rows: [row] };
  });
});

afterEach(async () => {
  fixtures.failWrite = null;
  vi.unstubAllEnvs();
  providerRequest.mockReset();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('privacy vault mutations and existing local run artifacts', () => {
  it.each([
    ['unsharing a vault record', () => updateVaultRecord('record-example', { shareWithTwin: false })],
    ['overwriting a vault record value', () => updateVaultRecord('record-example', { value: 'a replacement name' })],
    ['deleting a vault record', () => deleteVaultRecord('record-example')],
    ['deleting a subject', () => deleteSubject('subject-example')],
  ])('scrubs legacy prompts and echoed values when %s', async (_label, mutate) => {
    await Promise.all([
      writeFixture(join(paths.flatAgent, 'raw.txt'), rawOutput),
      ...[paths.agent, paths.unrelatedAgent].flatMap(directory => [
        writeFixture(join(directory, 'raw.txt.gz'), compressedRaw),
        writeFixture(join(directory, 'raw-storage.json'), JSON.stringify(recordingManifest)),
      ]),
      writeFixture(join(paths.unrelatedAgent, 'raw.txt'), rawOutput),
    ]);
    await mutate();

    for (const directory of [paths.agent, paths.flatAgent, paths.twinRun]) {
      const stored = await readFile(join(directory, 'prompt.txt'), 'utf8');
      expect(stored).not.toContain(fact);
      expect(stored).toContain('Identity facts were included in the provider request and are not stored.');
      expect(stored).toContain(survivor);
    }
    for (const directory of [paths.agent, paths.flatAgent, paths.twinRun, paths.cosRun]) {
      expect(await readFile(join(directory, 'output.txt'), 'utf8')).toBe(`[redacted] — ${survivor}; similar: ${fact}son`);
    }
    expect(JSON.parse(await readFile(join(paths.twinRun, 'metadata.json'), 'utf8'))).toMatchObject({
      purpose: 'test', prompt: await readFile(join(paths.twinRun, 'prompt.txt'), 'utf8'),
    });
    expect(await readFile(join(paths.cosRun, 'prompt.txt'), 'utf8')).toBe(survivor);
    expect(await readFile(join(paths.unrelated, 'output.txt'), 'utf8')).toBe(output);
    expect(await readFile(join(paths.backup, 'prompt.txt'), 'utf8')).toBe(prompt);

    const expectedRaw = Buffer.from(rawOutput.replace(fact, '[redacted]'));
    expect(await readFile(join(paths.flatAgent, 'raw.txt'))).toEqual(expectedRaw);
    expect(gunzipSync(await readFile(join(paths.agent, 'raw.txt.gz')))).toEqual(expectedRaw);
    expect(JSON.parse(await readFile(join(paths.agent, 'raw-storage.json'), 'utf8'))).toEqual({
      ...recordingManifest, sha256: createHash('sha256').update(expectedRaw).digest('hex'), originalBytes: expectedRaw.length,
    });
    expect(await readFile(join(paths.unrelatedAgent, 'raw.txt'), 'utf8')).toBe(rawOutput);
    expect(await readFile(join(paths.unrelatedAgent, 'raw.txt.gz'))).toEqual(compressedRaw);
    expect(await readFile(join(paths.unrelatedAgent, 'raw-storage.json'), 'utf8')).toBe(JSON.stringify(recordingManifest));
    expect([log, warn, error].flatMap(spy => spy.mock.calls.flat()).join('\n')).not.toContain(fact);
  });

  it('scrubs both formats when a compressed recording has no manifest', async () => {
    await Promise.all([
      writeFixture(join(paths.agent, 'raw.txt'), rawOutput),
      writeFixture(join(paths.agent, 'raw.txt.gz'), compressedRaw),
    ]);
    await deleteVaultRecord('record-example');
    const expectedRaw = Buffer.from(rawOutput.replace(fact, '[redacted]'));
    expect(await readFile(join(paths.agent, 'raw.txt'))).toEqual(expectedRaw);
    expect(gunzipSync(await readFile(join(paths.agent, 'raw.txt.gz')))).toEqual(expectedRaw);
    await expect(readFile(join(paths.agent, 'raw-storage.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('retires abandoned regular-file compression stages in affected archives only', async () => {
    const stage = 'raw.txt.gz.00000000-0000-4000-8000-000000000001.tmp';
    const directory = 'raw.txt.gz.00000000-0000-4000-8000-000000000002.tmp';
    const link = 'raw.txt.gz.00000000-0000-4000-8000-000000000003.tmp';
    const nearby = 'raw.txt.gz.00000000-0000-4000-8000-00000000000g.tmp';
    await Promise.all([
      ...[paths.agent, paths.unrelatedAgent, paths.flatAgent].map(dir => writeFixture(join(dir, stage), compressedRaw)),
      writeFixture(join(paths.agent, directory, 'keep.txt'), survivor),
      writeFixture(join(paths.agent, nearby), survivor),
    ]);
    // This stage-looking symlink must survive without its target being followed.
    if (process.platform !== 'win32') await symlink(nearby, join(paths.agent, link));
    await deleteVaultRecord('record-example');

    await expect(readFile(join(paths.agent, stage))).rejects.toMatchObject({ code: 'ENOENT' });
    for (const dir of [paths.unrelatedAgent, paths.flatAgent]) {
      expect(await readFile(join(dir, stage))).toEqual(compressedRaw);
    }
    expect(await readFile(join(paths.agent, directory, 'keep.txt'), 'utf8')).toBe(survivor);
    expect(await readFile(join(paths.agent, nearby), 'utf8')).toBe(survivor);
    if (process.platform !== 'win32') expect(await readFile(join(paths.agent, link), 'utf8')).toBe(survivor);
  });

  it('restores the original compressed recording if its manifest update fails', async () => {
    const compressedPath = join(paths.agent, 'raw.txt.gz');
    const manifestPath = join(paths.agent, 'raw-storage.json');
    await Promise.all([
      writeFixture(compressedPath, compressedRaw),
      writeFixture(manifestPath, JSON.stringify(recordingManifest)),
    ]);
    fixtures.failWrite = manifestPath;
    await expect(deleteVaultRecord('record-example')).rejects.toMatchObject({ code: 'PRIVACY_RUN_SCRUB_FAILED' });
    expect(await readFile(compressedPath)).toEqual(compressedRaw);
    expect(await readFile(manifestPath, 'utf8')).toBe(JSON.stringify(recordingManifest));
  });

  it('redacts pending and subsequent PTY output from an active private agent', async () => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({
      agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt,
    });
    spooler.pushRaw(rawOutput);
    try {
      await deleteVaultRecord('record-example');
      await spooler.flushRaw();
      spooler.pushRaw(rawOutput);
      await spooler.drainRaw();
      expect(await readFile(rawFile, 'utf8')).toBe(rawOutput.replace(fact, '[redacted]').repeat(2));
    } finally {
      await spooler.drainRaw();
    }
  });

  it.each(['before the first flush', 'between flushes', 'after finalization'])('preserves terminal formatting when a fact is revoked %s', async when => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({ agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt });
    const color = '\x1b[32m';
    const bold = '\x9b1m';
    const reset = '\x1b[0m';
    const open = '\x1b]8;;https://example.com\x1b\\';
    const close = '\x9d8;;\x9c';
    const batches = [`keep ${color}Sky\x9b`, `1mlar Ex`, `ample${reset}, ${open}${fact}`, `${close}son\r\n${fact}`];
    const original = batches.join('');
    await writeFixture(join(paths.agent, 'raw.txt.gz'), gzipSync(original));
    await writeFixture(join(paths.unrelatedAgent, 'raw.txt'), original);
    if (when === 'before the first flush') await deleteVaultRecord('record-example');
    for (const [index, batch] of batches.entries()) {
      spooler.pushRaw(batch);
      await spooler.flushRaw();
      if (index === 0 && when === 'between flushes') await deleteVaultRecord('record-example');
    }
    await spooler.drainRaw();
    if (when === 'after finalization') await deleteVaultRecord('record-example');
    const expected = `keep ${color}[redacted]${bold}${reset}, ${open}${fact}${close}son\r\n[redacted]`;
    expect(await readFile(rawFile, 'utf8')).toBe(expected);
    expect(gunzipSync(await readFile(join(paths.agent, 'raw.txt.gz'))).toString()).toBe(expected);
    expect(await readFile(join(paths.unrelatedAgent, 'raw.txt'), 'utf8')).toBe(original);
  });

  it('keeps the original Unicode word boundaries and longest match across output batches', async () => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({ agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt });
    await scrubRevokedPrivacyFacts(['!+', 'Cat', 'Cat Dog'].map(value => encryptValue(value)));
    for (const batch of ['Cat ', 'Dog / Cat ', 'Dogwood / ', '𐐀', '!+ / ', '!+']) {
      spooler.pushRaw(batch);
      await spooler.flushRaw();
    }
    await spooler.drainRaw();
    expect(await readFile(rawFile, 'utf8')).toBe('[redacted] / [redacted] Dogwood / 𐐀!+ / [redacted]');
  });

  it('replays the written prefix and pending suffix together when another fact is revoked', async () => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({ agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt });
    await scrubRevokedPrivacyFacts([encryptValue('Exhibit')]);
    spooler.pushRaw('Exhibit Skylar Ex');
    await spooler.flushRaw();
    expect(await readFile(rawFile, 'utf8')).toBe('[redacted] Skylar ');
    await deleteVaultRecord('record-example');
    spooler.pushRaw('ample');
    await spooler.drainRaw();
    expect(await readFile(rawFile, 'utf8')).toBe('[redacted] [redacted]');
  });

  it('re-evaluates a capped batch with revocations received while publishing truncation metadata', async () => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({ agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt });
    const { updateAgent } = await import('./cos/cosAgentLifecycle.js');
    updateAgent.mockImplementationOnce(() => deleteVaultRecord('record-example'));
    spooler.pushRaw('x'.repeat(245));
    await spooler.flushRaw();
    spooler.pushRaw(`\r\n${fact} / Skylar`);
    await spooler.flushRaw();
    spooler.pushRaw(' Example!');
    await spooler.drainRaw();
    // The current batch survives rollover with both its complete and split fact scrubbed.
    expect(await readFile(rawFile, 'utf8')).toBe('\r\n[redacted] / [redacted]!');
    expect(updateAgent).toHaveBeenCalledWith('agent-active', { metadata: { rawSpoolTruncated: true } });
  });

  it.each([false, true])('rechecks a newly exposed whole word at the start of a cap rewrite (oversized batch %s)', async oversized => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({ agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt });
    await deleteVaultRecord('record-example');
    spooler.pushRaw('x'.repeat(256));
    await spooler.flushRaw();
    // Before rollover the preceding x makes the fact part of a longer word.
    const remainder = '!'.repeat(256 - fact.length);
    spooler.pushRaw(`${oversized ? 'x' : ''}${fact}${remainder}`);
    await spooler.drainRaw();
    expect(await readFile(rawFile, 'utf8')).toBe(`[redacted]${remainder}`);
  });

  it('bounds formatting held inside an undecided fact and preserves intact UTF-8 on rollover', async () => {
    const rawFile = join(paths.flatAgent, 'raw.txt');
    const spooler = createOutputSpooler({ agentId: 'agent-active', outputFile: join(paths.flatAgent, 'output.txt'), rawFile, prompt });
    await deleteVaultRecord('record-example');
    const controls = '\x1b[1m'.repeat(64);
    spooler.pushRaw(`Sky${controls}`);
    await spooler.flushRaw();
    spooler.pushRaw(`lar Example! ${fact}`);
    await spooler.drainRaw();
    const retained = await readFile(rawFile, 'utf8');
    expect(Buffer.byteLength(retained)).toBeLessThanOrEqual(256);
    expect(retained).toMatch(/lar Example! \[redacted\]$/);
    expect(retained).not.toContain('Sky');

    const unicodeFile = join(paths.agent, 'raw.txt');
    const other = createOutputSpooler({ agentId: 'agent-example', rawFile: unicodeFile, outputFile: join(paths.agent, 'output.txt'), prompt });
    other.pushRaw('界'.repeat(100));
    await other.drainRaw();
    expect(await readFile(unicodeFile, 'utf8')).toBe('界'.repeat(85));
  });

  it('clears broker identity evidence when a legal_name value is overwritten', async () => {
    await updateVaultRecord('record-example', { value: 'a replacement name' });
    expect(clearSubjectIdentityEvidence).toHaveBeenCalledWith(PRIVACY_SELF_SUBJECT_ID, expect.objectContaining({ client: expect.anything() }));
  });

  it('does not clear broker identity evidence when only shareWithTwin is revoked', async () => {
    await updateVaultRecord('record-example', { shareWithTwin: false });
    expect(clearSubjectIdentityEvidence).not.toHaveBeenCalled();
  });
});

describe('historical Digital Twin cleanup', () => {
  const runId = '00000000-0000-4000-8000-000000000012';
  const otherId = '00000000-0000-4000-8000-000000000013';
  const entryId = '00000000-0000-4000-8000-000000000014';
  const time = '2026-01-01T00:00:00.000Z';
  const feedbackFile = () => join(fixtures.paths.digitalTwin, 'feedback.json');
  const runFile = (id, name) => join(fixtures.paths.runs, id, name);
  const read = path => readFile(path, 'utf8');
  const scrub = () => cleanHistoricalTwinArtifacts({ action: 'scrub', recordId: '00000000-0000-4000-8000-000000000015' });
  const remove = (kind, id) => cleanHistoricalTwinArtifacts({ action: 'delete', kind, id });
  const feedbackEntries = [
    { id: entryId, contentType: 'test_response', createdAt: time, contentSnippet: output, context: survivor },
    { id: otherId, contentType: 'enrichment', contentSnippet: output },
  ];
  const createRun = async (id, request, props = {}) => {
    const metadata = { id, type: 'ai', source: 'digital-twin', startTime: time, endTime: time,
      prompt: request.slice(0, 500), outputSize: Buffer.byteLength(output),
      error: output, errorAnalysis: { message: output }, ...props };
    await Promise.all(Object.entries({
      'metadata.json': JSON.stringify(metadata), 'prompt.txt': request, 'output.txt': output, 'tui-response.txt': output,
    }).map(([name, value]) => writeFixture(runFile(id, name), value)));
  };
  const scorerTemplate = async stage => (await readFile(new URL(`../../data.reference/prompts/stages/${stage}.md`, import.meta.url), 'utf8'))
    .replace(/{{(?:response|transcript)}}/g, fact).replace(/{{[^}]+}}/g, 'example');
  beforeEach(async () => {
    await writeFixture(feedbackFile(), JSON.stringify({ entries: feedbackEntries }));
  });

  it.each([
    ['soul-test-scorer', 'behavioral'],
    ['adversarial-boundary-scorer', 'adversarial'],
    ['values-alignment-scorer', 'values'],
    ['multi-turn-consistency-scorer', 'multi-turn'],
  ])('erases an exact fact from %s and typed feedback, preserving other records', async (stage, scorer) => {
    const request = await scorerTemplate(stage);
    await createRun(runId, request);
    await createRun(otherId, request, { source: 'example-unrelated' });
    const doc = join(fixtures.paths.digitalTwin, 'documents', 'example.md');
    await writeFixture(doc, output);
    expect(await cleanHistoricalTwinArtifacts({ action: 'list' })).toEqual({
      candidates: [
        { kind: 'run', id: runId, date: time, scorer },
        { kind: 'feedback', id: entryId, date: time },
      ],
    });
    expect(await scrub()).toEqual({ changed: 2 });
    expect(await scrub()).toEqual({ changed: 0 });
    expect(await read(runFile(runId, 'prompt.txt'))).toBe(request.replaceAll(fact, '[redacted]'));
    const cleanedOutput = output.replace(fact, '[redacted]');
    for (const name of ['tui-response.txt', 'output.txt']) {
      expect(await read(runFile(runId, name))).toBe(cleanedOutput);
      expect(await read(runFile(otherId, name))).toBe(output);
    }
    expect(JSON.parse(await read(runFile(runId, 'metadata.json')))).toMatchObject({
      prompt: request.replaceAll(fact, '[redacted]').slice(0, 500), outputSize: Buffer.byteLength(cleanedOutput),
      error: cleanedOutput, errorAnalysis: { message: cleanedOutput },
    });
    expect(JSON.parse(await read(feedbackFile())).entries).toEqual([
      { ...feedbackEntries[0], contentSnippet: cleanedOutput }, feedbackEntries[1],
    ]);
    expect(await read(doc)).toBe(output);
    expect([log, warn, error].flatMap(spy => spy.mock.calls.flat()).join('\n')).not.toContain(fact);
  });

  it('deletes a selected completed Digital Twin run or feedback excerpt when the value is lost', async () => {
    await createRun(runId, output);
    await createRun(otherId, output, { endTime: null });
    expect(await scrub()).toEqual({ changed: 1 });
    expect(await read(runFile(runId, 'output.txt'))).toBe(output);
    expect((await cleanHistoricalTwinArtifacts({ action: 'list' })).candidates[0]).toEqual({
      kind: 'run', id: runId, date: time, scorer: 'unclassified',
    });
    fixtures.query.mockResolvedValue({ rows: [] });
    await expect(scrub()).rejects.toMatchObject({ code: 'PRIVACY_ARTIFACT_NOT_FOUND' });
    await expect(remove('run', otherId)).rejects.toMatchObject({ code: 'PRIVACY_ARTIFACT_NOT_FOUND' });
    await expect(remove('feedback', otherId)).rejects.toMatchObject({ code: 'PRIVACY_ARTIFACT_NOT_FOUND' });
    expect(await remove('run', runId)).toEqual({ changed: 1 });
    await expect(read(runFile(runId, 'prompt.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await remove('feedback', entryId)).toEqual({ changed: 1 });
    expect(await remove('feedback', entryId)).toEqual({ changed: 0 });
    expect(JSON.parse(await read(feedbackFile())).entries).toEqual([
      { ...feedbackEntries[0], contentSnippet: '' }, feedbackEntries[1],
    ]);
    expect(await read(runFile(otherId, 'output.txt'))).toBe(output);
  });

  it('retains retry evidence after a partial revocation and keeps failed reads private', async () => {
    const request = await scorerTemplate('adversarial-boundary-scorer');
    await createRun(runId, request);
    fixtures.failWrite = runFile(runId, 'prompt.txt');
    await expect(deleteVaultRecord('record-example')).rejects.toMatchObject({ code: 'PRIVACY_RUN_SCRUB_FAILED' });
    await deleteVaultRecord('record-example');
    expect(await read(runFile(runId, 'prompt.txt'))).toBe(request.replaceAll(fact, '[redacted]'));
    expect(JSON.parse(await read(feedbackFile())).entries[0].contentSnippet).toBe(output.replace(fact, '[redacted]'));
    await writeFixture(feedbackFile(), fact);
    const failure = await scrub().catch(e => e);
    expect(failure).toMatchObject({ code: 'PRIVACY_RUN_SCRUB_FAILED', stack: failure.message });
    expect(await read(feedbackFile())).toBe(fact);
    const report = [failure.message, ...[log, warn, error].flatMap(spy => spy.mock.calls.flat())].join('\n');
    expect(report).not.toContain(fact);
    expect(report).not.toContain(root);
  });
});

describe('vault revocation and API run publication', () => {
  it.each([
    ['before the response', true, prompt],
    ['after the response', false, prompt],
    ['during an unrelated run', true, survivor],
  ])('preserves the correct stored output when revocation happens %s', async (_label, revokeFirst, request) => {
    const publication = new AsyncLocalStorage();
    const privateTurn = (path, work) => {
      expect(publication.getStore()).toBe('admitted');
      return withRuntimeFileTurn(path, work);
    };
    const runner = createRunnerService({
      dataDir: root, providerService: {}, redactStoredPrompt: redactStoredPrivacyPrompt,
      withAssetPublication: work => publication.run('admitted', work),
      hooks: { trackRunOutput: (path, sent) => trackPrivateRunOutput(path, sent, privateTurn) },
    });
    const provider = { id: 'example', type: 'api', endpoint: 'https://api.example.com/v1', defaultModel: 'example-model' };
    const { runId, runDir } = await runner.createRun({ providerId: provider.id, provider, prompt: request });
    const stream = new TransformStream();
    const fetch = vi.fn(async () => new Response(stream.readable));
    providerRequest.mockImplementation(fetch);
    const settled = Promise.withResolvers();
    await runner.executeApiRun({ runId, provider, prompt: request, onSettled: settled.resolve });
    expect(JSON.parse(fetch.mock.calls[0][1].body).messages[0].content).toBe(request);
    expect(await runner.getRunPrompt(runId)).not.toContain(fact);
    if (revokeFirst) await deleteVaultRecord('record-example');

    const writer = stream.writable.getWriter();
    const echo = `${fact} — ${survivor}`;
    const frame = { choices: [{ delta: { content: echo } }] };
    await writer.write(new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n`));
    await writer.close();
    await settled.promise;
    if (!revokeFirst) {
      expect(await runner.getRunOutput(runId)).toBe(echo);
      await deleteVaultRecord('record-example');
    }

    const expected = request === prompt ? `[redacted] — ${survivor}` : echo;
    expect(await runner.getRunOutput(runId)).toBe(expected);
    expect(await runner.getRun(runId)).toMatchObject({ success: true, outputSize: Buffer.byteLength(expected) });
    expect((await readdir(runDir)).sort()).toEqual(['metadata.json', 'output.txt', 'prompt.txt']);
    expect([log, warn, error].flatMap(spy => spy.mock.calls.flat()).join('\n')).not.toContain(fact);
  });
});
