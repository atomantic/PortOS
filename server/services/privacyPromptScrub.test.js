import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fenceBlock } from '../lib/promptFencing.js';
import { PRIVACY_FACTS_HEADING, PRIVACY_FACTS_NOTICE, redactStoredPrivacyPrompt, trackPrivateRunOutput } from '../lib/privacyPrompt.js';
import { PRIVACY_SELF_SUBJECT_ID } from '../lib/privacyConstants.js';
import { encryptValue } from '../lib/vaultCrypto.js';
import { deleteVaultRecord, updateVaultRecord } from './privacyVault.js';
import { createRunnerService } from '../lib/aiToolkit/runner.js';
import { withRuntimeFileTurn } from '../lib/runtimeFilePublication.js';
import { deleteSubject } from './privacySubjects.js';

const fixtures = vi.hoisted(() => ({ paths: {}, query: vi.fn() }));
vi.mock('../lib/db.js', () => ({
  query: fixtures.query,
  withTransaction: fn => fn({ query: fixtures.query }),
}));
vi.mock('../lib/fileUtils.js', async actual => ({ ...await actual(), PATHS: fixtures.paths }));
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
  log = vi.spyOn(console, 'log').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  error = vi.spyOn(console, 'error').mockImplementation(() => {});
  root = await mkdtemp(join(tmpdir(), 'privacy-prompt-scrub-'));
  Object.assign(fixtures.paths, { cosAgents: join(root, 'agents'), runs: join(root, 'runs') });
  paths = {
    agent: join(fixtures.paths.cosAgents, '2026-01-01', 'agent-example'),
    flatAgent: join(fixtures.paths.cosAgents, 'agent-active'),
    twinRun: join(fixtures.paths.runs, 'twin-run'),
    cosRun: join(fixtures.paths.runs, 'cos-run'),
    unrelated: join(fixtures.paths.runs, 'unrelated-run'),
    backup: join(root, 'backups', 'runs', 'twin-run'),
  };
  await Promise.all(Object.values(paths).flatMap(directory => [
    writeFixture(join(directory, 'prompt.txt'), [paths.cosRun, paths.unrelated].includes(directory) ? survivor : prompt),
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
});

describe('privacy vault mutations and existing local run artifacts', () => {
  it.each([
    ['unsharing a vault record', () => updateVaultRecord('record-example', { shareWithTwin: false })],
    ['deleting a vault record', () => deleteVaultRecord('record-example')],
    ['deleting a subject', () => deleteSubject('subject-example')],
  ])('scrubs legacy prompts and echoed values when %s', async (_label, mutate) => {
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
    expect([log, warn, error].flatMap(spy => spy.mock.calls.flat()).join('\n')).not.toContain(fact);
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
    vi.stubGlobal('fetch', fetch);
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
