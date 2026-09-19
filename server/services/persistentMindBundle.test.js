import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openMindBundle, readMindBundleHeader } from '../lib/mindBundleCrypto.js';

const loadState = vi.fn();
const readPersistentMindMemories = vi.fn();
const readPersistentMindName = vi.fn();

vi.mock('./cosState.js', () => ({ loadState: (...args) => loadState(...args) }));
vi.mock('./persistentMindContext.js', () => ({
  readPersistentMindMemories: (...args) => readPersistentMindMemories(...args),
  readPersistentMindName: (...args) => readPersistentMindName(...args),
}));

const {
  collectPersistentMindBundleEntries,
  exportPersistentMindBundle,
  mindBundleFilename,
  normalizeMindBundleScopes,
} = await import('./persistentMindBundle.js');

const PASSPHRASE = 'an example bundle passphrase';

// An obviously-fake Mind carrying one of every install-bound value the bundle
// must strip. Nothing here is read out of a live install.
const FIXTURE_MEMORY = {
  id: '3f9c1b2e-7a41-4d0a-9c55-0d1e2f3a4b5c',
  sourceAgentId: 'cos-persistent-mind',
  sourceTaskId: 'task-9f2b7c31',
  embedding: [0.11, -0.42, 0.7],
  sourcePath: '/Users/example-user/github.com/example/PortOS/data/cos/notes.json',
  host: 'example-host.example-tailnet.ts.net',
  status: 'active',
  importance: 0.92,
  updatedAt: '2026-09-02T10:00:00.000Z',
};

const coreMemory = (overrides = {}) => ({
  ...FIXTURE_MEMORY,
  type: 'fact',
  content: 'The example user reviews plans on Friday afternoons.',
  createdAt: '2026-09-01T12:00:00.000Z',
  protection: 'core-identity',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  loadState.mockResolvedValue({
    config: {
      avatarStyle: 'cyber',
      persistentMindProfile: { enabled: true, providerId: 'example-provider', model: 'example-model', effort: 'high', wakeIntervalMinutes: 45 },
      persistentMindPrompt: { identity: 'I am the example Mind.', instructions: 'Stay candid and concise.' },
      persistentMindPlaybook: { mode: 'continuous-play', customInstructions: 'Prefer small experiments.' },
      persistentMindCapabilities: { createTasks: true, fileIssues: true },
      persistentMindThinkingPresets: [{ id: 'preset-1', label: 'Deep', providerId: 'example-provider', model: 'example-model' }],
    },
  });
  readPersistentMindName.mockResolvedValue('Example Mind');
  readPersistentMindMemories.mockResolvedValue([
    coreMemory(),
    coreMemory({ content: 'The example user is learning bass guitar.', protection: 'important' }),
    coreMemory({ content: 'Ordinary chatter nobody needs on another machine.', protection: 'standard' }),
  ]);
});

const openExport = async (scopes) => {
  const { bundle, filename, scopes: sealed } = await exportPersistentMindBundle({ scopes, passphrase: PASSPHRASE });
  const opened = await openMindBundle({ text: bundle, passphrase: PASSPHRASE });
  const documents = Object.fromEntries(opened.entries.map((entry) => [entry.name, JSON.parse(entry.data.toString('utf8'))]));
  return { bundle, filename, sealed, header: opened.header, documents };
};

describe('persistentMindBundle scopes', () => {
  it('defaults to profile + avatar, with protected memories opt-in', async () => {
    expect(normalizeMindBundleScopes()).toEqual(['profile', 'avatar']);
    expect(normalizeMindBundleScopes([])).toEqual(['profile', 'avatar']);
    // Requested order never changes what the header declares.
    expect(normalizeMindBundleScopes(['memories', 'profile'])).toEqual(['profile', 'memories']);
  });

  it('seals only the selected scopes and declares them in the cleartext header', async () => {
    const { header, documents, sealed } = await openExport(['profile', 'memories']);
    expect(sealed).toEqual(['profile', 'memories']);
    expect(header.scopes).toEqual(['profile', 'memories']);
    expect(Object.keys(documents).sort()).toEqual(['memories.json', 'profile.json']);
    expect(documents['profile.json'].chosenName).toBe('Example Mind');
    expect(documents['profile.json'].soul.identity).toBe('I am the example Mind.');
    expect(documents['profile.json'].playbook.mode).toBe('continuous-play');
    expect(documents['profile.json'].modelPolicy).toMatchObject({ providerId: 'example-provider', model: 'example-model', effort: 'high', wakeIntervalMinutes: 45 });
  });

  it('carries the avatar style from the bundled vocabulary, and nothing when it is unknown', async () => {
    expect((await openExport(['avatar'])).documents['avatar.json']).toEqual({ style: 'cyber' });
    loadState.mockResolvedValue({ config: { avatarStyle: 'not-a-shipped-style' } });
    expect((await openExport(['avatar'])).documents['avatar.json']).toEqual({ style: null });
  });
});

describe('persistentMindBundle privacy boundary', () => {
  it('never carries a standard-protection memory, even when memories are selected', async () => {
    const { documents, bundle } = await openExport(['memories']);
    const contents = documents['memories.json'].memories.map((memory) => memory.content);
    expect(contents).toEqual([
      'The example user reviews plans on Friday afternoons.',
      'The example user is learning bass guitar.',
    ]);
    expect(bundle).not.toContain('Ordinary chatter');
  });

  it('reduces a memory to meaning only — no ids, source agent/task, or embeddings', async () => {
    const { documents } = await openExport(['memories']);
    expect(documents['memories.json'].memories[0]).toEqual({
      type: 'fact',
      content: 'The example user reviews plans on Friday afternoons.',
      createdAt: '2026-09-01T12:00:00.000Z',
      protection: 'core-identity',
    });
  });

  it('strips every install-bound and sensitive value from the sealed payload', async () => {
    const { documents } = await openExport(['profile', 'avatar', 'memories']);
    const serialized = JSON.stringify(documents);
    const forbidden = [
      // Install-bound identifiers that would make the bundle un-openable or
      // re-linkable somewhere else.
      FIXTURE_MEMORY.id, 'sourceAgentId', 'sourceTaskId', 'cos-persistent-mind',
      'embedding', 'importance',
      // AGENTS.md Sensitive Data & Privacy categories.
      '/Users/', '/home/', '.ts.net', 'example-host', 'PRIVACY_VAULT_KEY',
      // Authority grants and lifecycle state stay home: an import must never
      // widen what a Mind may do, or start one.
      'createTasks', 'fileIssues', 'enabled',
      // Route bookmarks are this machine's registry, not the Mind's meaning.
      'thinkingPresets', 'preset-1',
    ];
    for (const needle of forbidden) expect(serialized).not.toContain(needle);
  });

  it('keeps every plaintext value out of the cleartext preamble', async () => {
    const { bundle } = await openExport(['profile', 'memories']);
    const preamble = bundle.split('\n').slice(0, 2).join('\n');
    expect(preamble).not.toContain('Example Mind');
    expect(preamble).not.toContain('example-provider');
    expect(preamble).not.toContain('Friday afternoons');
  });

  it('names the file without a hostname, a user, or the Mind\'s own name', () => {
    const filename = mindBundleFilename(new Date('2026-09-18T14:05:06.789Z'));
    expect(filename).toBe('portos-mind-2026-09-18T14-05-06Z.portos-mind');
  });
});

describe('persistentMindBundle refusal', () => {
  it('refuses the whole export when a selected scope cannot be read', async () => {
    readPersistentMindMemories.mockRejectedValue(new Error('memory backend is unavailable'));
    await expect(exportPersistentMindBundle({ scopes: ['profile', 'memories'], passphrase: PASSPHRASE }))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_SCOPE_UNREADABLE', status: 409 });
  });

  it('names every scope that failed, not just the first', async () => {
    loadState.mockRejectedValue(new Error('cos state is unreadable'));
    readPersistentMindMemories.mockRejectedValue(new Error('memory backend is unavailable'));
    await expect(collectPersistentMindBundleEntries(['profile', 'avatar', 'memories']))
      .rejects.toThrow(/profile .*avatar .*memories/s);
  });

  it('refuses rather than shipping a truncated protected-memory set', async () => {
    readPersistentMindMemories.mockResolvedValue(
      Array.from({ length: 100 }, (_unused, index) => coreMemory({ content: `Example protected memory ${index}` })),
    );
    await expect(collectPersistentMindBundleEntries(['memories']))
      .rejects.toThrow(/more than one bundle page can carry/);
  });

  it('refuses an empty scope selection', async () => {
    await expect(collectPersistentMindBundleEntries(['not-a-scope']))
      .rejects.toMatchObject({ code: 'MIND_BUNDLE_NO_SCOPES' });
  });

  it('produces a bundle whose cleartext header is readable without the passphrase', async () => {
    const { bundle } = await openExport(['profile']);
    const { header } = readMindBundleHeader(bundle);
    expect(header.scopes).toEqual(['profile']);
    expect(header.manifest).toEqual([{ name: 'profile.json', bytes: expect.any(Number) }]);
  });
});
